# PixGate: gateway PIX com Asaas

Site com login, cadastro, verificação de identidade (KYC), saldo, receber PIX (cobrança com QR Code), sacar PIX e painel admin com taxas por usuário.

Como funciona o dinheiro:

- **Receber:** o usuário gera uma cobrança. O Asaas devolve o QR Code. Quando o cliente paga, o Asaas avisa o servidor (webhook), o servidor confirma na API do Asaas e credita o saldo do usuário (valor menos a taxa).
- **Sacar:** o servidor desconta o saldo do usuário (valor mais a taxa) e manda o PIX pelo Asaas. Se o banco recusar, o saldo volta sozinho.
- **Seu dinheiro:** todo o dinheiro fica na **sua** conta Asaas. O sistema guarda um controle interno de quanto cada usuário tem. As taxas ficam com você.

## Passo a passo

### 1. Conta no Asaas (comece pelo sandbox)
1. Crie uma conta de testes em https://sandbox.asaas.com
2. Vá em **Integrações > Chave de API** e gere uma chave.
3. Só depois de tudo funcionando no sandbox, crie e aprove a conta de produção (https://www.asaas.com) e gere a chave de produção.

### 2. Rodar no seu computador (teste)
Precisa do Node.js 18 ou mais novo.

```
npm install
cp .env.example .env     # edite o .env e preencha
npm start
```
Abra http://localhost:3000. Login admin: o `ADMIN_USER` e `ADMIN_PASSWORD` do seu `.env`.

### 3. Colocar no ar
Use uma hospedagem de Node com **disco persistente** (Render, Railway, Fly.io ou um VPS). O banco SQLite e os documentos do KYC ficam em `DATA_DIR`; sem disco persistente você perde tudo a cada deploy.
- Comando de build: `npm install`
- Comando de start: `npm start`
- Variáveis: as mesmas do `.env.example` (com `JWT_SECRET` e `ASAAS_WEBHOOK_TOKEN` bem longos).
- É preciso ter **HTTPS** (as hospedagens acima já dão).

### 4. Webhook (é o que faz o saldo cair)
No painel do Asaas, em **Integrações > Webhooks**, crie um webhook:
- URL: `https://SEU-DOMINIO/api/webhooks/asaas`
- Token de autenticação: exatamente o mesmo valor de `ASAAS_WEBHOOK_TOKEN`
- Eventos: marque os de **Cobranças** (PAYMENT_*) e os de **Transferências** (TRANSFER_*)

### 5. Testar no sandbox
1. Crie uma conta de usuário no site e envie o KYC.
2. Entre como admin, vá em **Usuários**, abra o usuário e **Aprove** o KYC.
3. Como usuário, gere uma cobrança na aba **Receber**.
4. No painel do sandbox do Asaas, simule/confirme o pagamento dessa cobrança. O saldo deve cair em poucos segundos.
5. Faça um saque na aba **Enviar** e confirme que o status vai para Concluído.

### 6. Ir para produção
Troque `ASAAS_ENV=production`, use a chave de produção, atualize o webhook na conta de produção, **troque a senha do admin** e faça um teste com valor pequeno.

## Avisos importantes (leia antes de usar com dinheiro real)

- **Regulação.** Guardar e movimentar dinheiro de terceiros costuma exigir autorização do Banco Central. O modelo deste projeto (uma conta Asaas sua + saldos internos) é o mais simples, mas o dinheiro dos usuários fica numa conta que é sua. O caminho recomendado para operar em escala é o produto de **subcontas (BaaS) do Asaas**, que exige habilitação com o gerente de contas do Asaas e tem período de avaliação regulatória. Fale com o Asaas e com um contador/advogado antes de abrir para o público.
- **Taxas.** O Asaas cobra de você por PIX recebido e enviado. Ajuste as taxas no painel admin para cobrir esses custos e dar margem. Os padrões do projeto (1,5% + R$ 2,00 para receber; R$ 2,00 para sacar) são só um ponto de partida.
- **Autorização de saques por API.** O Asaas pode exigir que você configure uma autorização para transferências feitas por API. Confira em Integrações no seu painel; sem isso os saques podem ficar pendentes ou ser recusados.
- **Saque preso.** Se a conexão cair no meio de um saque, ele fica como "Processando" e **não** é devolvido sozinho (para não duplicar). Confira no Asaas e ajuste o saldo pelo painel admin se precisar.
- **Segurança.** Troque a senha do admin, mantenha o `.env` fora do Git, faça backup do `DATA_DIR` e proteja o acesso ao servidor. Os documentos do KYC contêm dados pessoais (LGPD).
- **Limites do Asaas.** O Asaas pode ter valor mínimo de cobrança e limites diários. Ajuste `MIN_AMOUNT_CENTS` se necessário.
