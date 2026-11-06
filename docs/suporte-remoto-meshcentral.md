# Suporte remoto — MeshCentral no EasyPanel (DEV e produção)

Roteiro do operador para subir o servidor MeshCentral que o widget
**Suporte remoto** (`remote_support`) usa, e ligar a API nele. O CRM é quem
cria e apaga os grupos no MeshCentral e gera os links; o operador só sobe o
servidor uma vez e informa as variáveis à API.

O que o cliente final vê: abre o link `/suporte/{token}` (frontend), baixa o
MeshCentral Assistant já configurado, roda sem instalar e clica em **Permitir**
quando o atendente pede acesso. Encerrar a sessão apaga o grupo no servidor;
nada fica instalado.

Escrito para o **DEV**, onde o serviço se chama `dev_suporte-remoto` no projeto `crm` do EasyPanel e usa o domínio automático `crm-dev-suporte-remoto.ca31ey.easypanel.host`;
produção é o mesmo roteiro com outro domínio, outra senha e `title2` diferente.

## 1. Pré-requisitos

- Um domínio só para o MeshCentral com HTTPS válido: é esse endereço que vai
  embutido no arquivo que o cliente baixa e que o atendente abre no navegador.
  No DEV é o domínio automático do EasyPanel (`*.ca31ey.easypanel.host`, sem
  DNS para configurar); em produção, um domínio próprio com DNS apontando para
  o host do EasyPanel.
- A imagem `ghcr.io/ylianst/meshcentral`. Fixe a versão (`1.3.1` foi a
  validada); `selfUpdate` fica desligado no config.

## 2. Serviço MeshCentral no EasyPanel

No projeto do ambiente, crie um serviço **App** a partir de imagem:

| Campo | Valor |
|---|---|
| Imagem | `ghcr.io/ylianst/meshcentral:1.3.1` |
| Porta do container | `4430` (HTTP — o TLS termina no proxy do EasyPanel) |
| Domínio | o automático `crm-dev-suporte-remoto.ca31ey.easypanel.host` → porta `4430`, HTTPS ligado |
| Volume | `/opt/meshcentral/meshcentral-data` (**obrigatório** persistir: banco, contas e a identidade que os Assistants verificam) |
| Volume | `/opt/meshcentral/meshcentral-files` |
| Volume | `/opt/meshcentral/meshcentral-backups` |
| Arquivo montado | `/opt/meshcentral/meshcentral-data/config.json` com o conteúdo abaixo |
| Env | nenhuma é necessária (o config.json manda); `TZ=America/Sao_Paulo` é opcional |

`config.json` (troque o domínio nos dois lugares):

```json
{
  "$schema": "https://raw.githubusercontent.com/Ylianst/MeshCentral/master/meshcentral-config-schema.json",
  "settings": {
    "cert": "crm-dev-suporte-remoto.ca31ey.easypanel.host",
    "port": 4430,
    "aliasPort": 443,
    "redirPort": 0,
    "tlsOffload": true,
    "WANonly": true,
    "allowLoginToken": true,
    "selfUpdate": false
  },
  "domains": {
    "": {
      "title": "Suporte EduIT",
      "title2": "DEV",
      "certUrl": "https://crm-dev-suporte-remoto.ca31ey.easypanel.host:443/",
      "newAccounts": true,
      "agentInviteCodes": true
    }
  }
}
```

Por que cada chave:

- `port: 4430` + `tlsOffload: true`: o MeshCentral escuta HTTP e confia que o
  proxy do EasyPanel fez o TLS. `aliasPort: 443` é a porta que o mundo vê e a
  que entra nos links e no Assistant. `redirPort: 0` desliga o redirecionador
  HTTP (não é exposto).
- `certUrl`: de onde o MeshCentral lê o certificado que os **agentes** vão
  encontrar ao conectar (o do proxy). Sem isso o Assistant baixa, abre e não
  conecta.
- `agentInviteCodes: true`: libera o Assistant por link, que é o que o CRM usa.
- `allowLoginToken`, `WANonly`: como no ambiente local validado.
- `newAccounts: true` **só até criar as contas** (passo 3). Depois volta para
  `false`.
- `allowedOrigin` fica no padrão (o MeshCentral monta a lista a partir de
  `cert` + `aliasPort`). Se o login mostrar "Invalid origin", o domínio ou a
  porta do config não batem com o que o navegador usa; conserte isso em vez de
  abrir com `"allowedOrigin": true`.

Depois do deploy, `https://crm-dev-suporte-remoto.ca31ey.easypanel.host/` tem de mostrar a tela de
login do MeshCentral.

## 3. Contas

1. Abra `https://crm-dev-suporte-remoto.ca31ey.easypanel.host/` e crie a **primeira conta**: ela vira
   administradora do site. É a conta humana (ligue o 2FA nela).
2. Em **Meus Usuários → Novo Usuário**, crie `crm-svc` com uma senha longa
   gerada (guarde no cofre) e marque **Administrador do site**. É a conta que
   a API usa: ela cria e apaga grupos e gera links de compartilhamento. Sem
   2FA nessa conta — o protocolo de controle autentica com usuário e senha.
3. No arquivo montado, troque `"newAccounts": true` por `false` e reinicie o
   serviço.

## 4. API (`api` do ambiente)

Variáveis no serviço `api` (só nele; workers e `api-public` não usam):

```
MESHCENTRAL_URL=https://crm-dev-suporte-remoto.ca31ey.easypanel.host
MESHCENTRAL_PUBLIC_URL=https://crm-dev-suporte-remoto.ca31ey.easypanel.host
MESHCENTRAL_USER=crm-svc
MESHCENTRAL_PASSWORD=<senha do crm-svc>
# REMOTE_SUPPORT_SESSION_MINUTES=60   (opcional: validade do link do cliente)
```

`MESHCENTRAL_URL` é por onde a API fala com o servidor (WebSocket de controle)
e `MESHCENTRAL_PUBLIC_URL` é o que entra no link de download do cliente. Com o
domínio público nos dois, o tráfego passa pelo proxy com certificado válido,
e não há o que configurar na rede interna. **Não** defina
`MESHCENTRAL_TLS_INSECURE` (só vale fora de produção e aqui o certificado é
válido). Sem essas variáveis as rotas de suporte respondem 503 e o card avisa.

Redeploy do `api` depois de gravar.

## 5. Migrations

São duas, e entram sozinhas no boot do `api` (`RUN_MIGRATIONS_ON_BOOT`,
ligado por padrão — ver `deploy-seguro.md` §1):

- `20261106190000_remote_support_sessions`: tabela, enum, índices, FKs e o
  preset MANAGER ganha `remote_support:view` e `remote_support:start`.
- `20261106200000_remote_support_widget`: insere o widget no catálogo. Sem
  backfill: nenhuma org fica com ele instalado.

Confira no log do boot. Manualmente, é o comando de sempre do `deploy-seguro.md`.

## 6. Ligar na org e testar

1. No CRM, **Widgets → Suporte remoto → Instalar** (ADMIN da org). ADMIN já tem
   tudo; MANAGER ganhou as permissões pela migration; MEMBER o admin libera em
   Configurações → Permissões, se quiser.
2. Ficha de um contato → card **Suporte remoto** → **Iniciar suporte** →
   **Copiar** o link.
3. Num **Windows**, abra o link: a página mostra o passo a passo e o botão
   **Baixar o suporte**. Abra o `MeshCentralAssistant-….exe` (não instala). O
   card do CRM muda para **Cliente conectado** e a página do cliente também.
4. **Controlar** abre o console do MeshCentral numa aba; o cliente vê o pedido
   e clica **Permitir**. Sem o clique dele, o console fica em "Negado".
5. **Encerrar** apaga o grupo no servidor e o Assistant perde a conexão; o
   cliente fecha e apaga o arquivo.

Fora do Windows a página orienta a abrir o link num computador com Windows
(macOS e Linux exigiriam instalar o agente e liberar permissões do sistema, o
que foge da regra "nada de pedir para o cliente mexer em proteção").

### Pendência conhecida: assinatura do `.exe`

O Assistant não é assinado com certificado da EduIT. No Windows isso dá o
aviso do SmartScreen ("Mais informações → Executar assim mesmo") e, com o
**Smart App Control** ligado (Windows 11 novo), bloqueio sem opção. A saída
é um certificado de assinatura de código (OV, em nome do CNPJ; a chave fica em
hardware ou nuvem). O MeshCentral assina os agentes com o certificado que
estiver em `meshcentral-data`; com o OV em mãos é lá que ele entra (ver
"agent code signing" na documentação do MeshCentral).

## 7. Operação

- **Backup**: o volume `meshcentral-data` guarda contas e os certificados
  `agentserver-cert-*` (a identidade que todo Assistant verifica). Perdê-lo
  invalida Assistants já baixados — como as sessões duram 1 h, o impacto é
  pequeno, mas é refazer o passo 3.
- **Atualizar**: troque a tag da imagem e reinicie; `selfUpdate` está desligado.
- **Grupos órfãos**: cada sessão cria um grupo `Bwipo <id>`; encerrar ou
  expirar apaga. Se a API cair no meio, pode sobrar grupo vazio; apague pela
  tela do MeshCentral (não há dados do cliente nele).
- **Logs**: MeshCentral em *Meu Servidor → Rastreamento*; na API, o logger
  `remote-support`.
- **Local do desenvolvedor**: o compose usado para validar fica fora do repo,
  em `remote-support-mvp/meshcentral-selfhost` (Docker no Mac; a máquina
  Windows da rede não alcança o container por limitação do Colima, por isso o
  teste com Windows de verdade é feito no DEV).
