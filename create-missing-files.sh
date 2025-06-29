#!/bin/bash

# Script para criar os arquivos faltantes do projeto TalkHub MCP Server
# Uso: ./create-missing-files.sh

set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}📁 Criando arquivos faltantes do TalkHub MCP Server...${NC}"

# Criar diretórios se não existirem
echo -e "${YELLOW}📂 Criando diretórios...${NC}"
mkdir -p logs monitoring webhooks .vscode

# Criar arquivos .gitkeep para manter diretórios vazios no Git
echo -e "${YELLOW}📄 Criando arquivos .gitkeep...${NC}"
echo "# Este arquivo mantém o diretório no Git mesmo quando vazio" > logs/.gitkeep
echo "# Este arquivo mantém o diretório no Git mesmo quando vazio" > monitoring/.gitkeep
echo "# Este arquivo mantém o diretório no Git mesmo quando vazio" > webhooks/.gitkeep
echo -e "${GREEN}✓ Arquivos .gitkeep criados${NC}"

# Criar .gitignore se não existir
if [ ! -f ".gitignore" ]; then
    echo -e "${YELLOW}📄 Criando .gitignore...${NC}"
    cat > .gitignore << 'EOF'
# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Environment variables
.env
.env.local
.env.production
.env.backup.*

# Logs
logs/*.log
*.log

# Runtime data
pids
*.pid
*.seed
*.pid.lock

# Coverage directory used by tools like istanbul
coverage/

# Docker
.docker/

# OS generated files
.DS_Store
.DS_Store?
._*
.Spotlight-V100
.Trashes
ehthumbs.db
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo

# Temporary files
tmp/
temp/

# Build outputs
dist/
build/

# Cache
.cache/
.eslintcache

# Optional npm cache directory
.npm

# Optional REPL history
.node_repl_history

# Output of 'npm pack'
*.tgz

# Yarn Integrity file
.yarn-integrity

# dotenv environment variables file
.env.test

# parcel-bundler cache (https://parceljs.org/)
.cache
.parcel-cache

# next.js build output
.next

# nuxt.js build output
.nuxt

# vuepress build output
.vuepress/dist

# Serverless directories
.serverless

# FuseBox cache
.fusebox/

# DynamoDB Local files
.dynamodb/
EOF
    echo -e "${GREEN}✓ .gitignore criado${NC}"
else
    echo -e "${GREEN}✓ .gitignore já existe${NC}"
fi

# Criar .dockerignore se não existir
if [ ! -f ".dockerignore" ]; then
    echo -e "${YELLOW}🐳 Criando .dockerignore...${NC}"
    cat > .dockerignore << 'EOF'
node_modules
npm-debug.log
.git
.gitignore
README.md
.env
.env.example
.nyc_output
coverage
.docker
logs/*.log
.vscode
.idea
*.swp
*.swo
.DS_Store
Thumbs.db
.eslintcache
dist
build
temp
tmp
*.md
LICENSE
.github
docker-compose*.yml
organize-project.sh
EOF
    echo -e "${GREEN}✓ .dockerignore criado${NC}"
else
    echo -e "${GREEN}✓ .dockerignore já existe${NC}"
fi

# Criar docker-compose.dev.yml se não existir
if [ ! -f "docker-compose.dev.yml" ]; then
    echo -e "${YELLOW}🔧 Criando docker-compose.dev.yml...${NC}"
    cat > docker-compose.dev.yml << 'EOF'
version: '3.8'

services:
  mcp-server:
    build: .
    ports:
      - "3003:3003"
    environment:
      - NODE_ENV=development
      - PORT=3003
      - REDIS_URL=redis://redis:6379
      - SUPABASE_URL=https://supatalk.talkhub.me
      - SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzE1MDUwODAwLAogICJleHAiOiAxODcyODE3MjAwCn0.chLQyRz8PtQQCKYNrJvOfViDq769cZ226xHPNjAoGUc
      - JWT_SECRET=dev_jwt_secret_for_local_testing
      - ADMIN_SECRET=dev_admin_secret_for_local_testing
      - WEBHOOK_SECRET=dev_webhook_secret_for_local_testing
      - LOG_LEVEL=debug
      - RATE_LIMIT_WINDOW=1
      - RATE_LIMIT_MAX=1000
    volumes:
      - .:/app
      - /app/node_modules
      - ./logs:/app/logs
    depends_on:
      - redis
    command: npm run dev
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    restart: unless-stopped

  # Opcional: Redis Commander para visualizar dados do Redis
  redis-commander:
    image: rediscommander/redis-commander:latest
    hostname: redis-commander
    ports:
      - "8081:8081"
    environment:
      - REDIS_HOSTS=local:redis:6379
    depends_on:
      - redis
    profiles:
      - tools

  # Opcional: Adminer para visualizar dados do Supabase
  adminer:
    image: adminer
    ports:
      - "8080:8080"
    environment:
      - ADMINER_DEFAULT_SERVER=supatalk.talkhub.me:5344
    profiles:
      - tools

volumes:
  redis_data:

networks:
  default:
    name: talkhub-dev
EOF
    echo -e "${GREEN}✓ docker-compose.dev.yml criado${NC}"
else
    echo -e "${GREEN}✓ docker-compose.dev.yml já existe${NC}"
fi

# Criar configurações do VS Code
echo -e "${YELLOW}💻 Criando configurações do VS Code...${NC}"
cat > .vscode/settings.json << 'EOF'
{
  "editor.tabSize": 2,
  "editor.insertSpaces": true,
  "files.eol": "\n",
  "files.insertFinalNewline": true,
  "files.trimTrailingWhitespace": true,
  "javascript.preferences.quoteStyle": "single",
  "typescript.preferences.quoteStyle": "single",
  "eslint.validate": [
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact"
  ],
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
EOF

cat > .vscode/launch.json << 'EOF'
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Launch TalkHub MCP Server",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/server.js",
      "env": {
        "NODE_ENV": "development"
      },
      "envFile": "${workspaceFolder}/.env",
      "console": "integratedTerminal",
      "restart": true,
      "runtimeExecutable": "node",
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Debug Supabase Init",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/scripts/init-supabase.js",
      "envFile": "${workspaceFolder}/.env",
      "console": "integratedTerminal"
    }
  ]
}
EOF

cat > .vscode/extensions.json << 'EOF'
{
  "recommendations": [
    "ms-vscode.vscode-node-azure-pack",
    "bradlc.vscode-tailwindcss",
    "ms-vscode.vscode-docker",
    "ms-vscode.vscode-json",
    "ms-vscode.vscode-eslint",
    "esbenp.prettier-vscode",
    "formulahendry.auto-rename-tag",
    "ms-vscode.vscode-typescript-next"
  ]
}
EOF
echo -e "${GREEN}✓ Configurações do VS Code criadas${NC}"

# Criar README para cada diretório
echo -e "${YELLOW}📖 Criando READMEs dos diretórios...${NC}"

cat > logs/README.md << 'EOF'
# Logs Directory

Este diretório contém os arquivos de log da aplicação TalkHub MCP Server.

## Estrutura dos Logs

- `app.log` - Log principal da aplicação
- `error.log` - Logs de erro (se configurado)
- `access.log` - Logs de acesso HTTP (se configurado)

## Rotação de Logs

Os logs são automaticamente rotacionados quando atingem 10MB, mantendo até 5 arquivos históricos.

## Monitoramento

Para monitorar os logs em tempo real:

```bash
tail -f logs/app.log
```

Para filtrar apenas erros:

```bash
grep ERROR logs/app.log
```
EOF

cat > monitoring/README.md << 'EOF'
# Monitoring Directory

Este diretório contém configurações para monitoramento do TalkHub MCP Server.

## Arquivos de Configuração

- `prometheus.yml` - Configuração do Prometheus (criado automaticamente no deploy)
- `grafana-dashboards/` - Dashboards personalizados do Grafana
- `alerts.yml` - Regras de alertas do Prometheus

## Como Usar

As configurações são criadas automaticamente durante o deploy:

```bash
./deploy-talkhub.sh deploy
```

## Acessar Monitoramento

- **Prometheus**: https://prometheus.talkhub.me
- **Grafana**: https://monitoring.talkhub.me

## Métricas Disponíveis

- Saúde da aplicação
- Performance do Redis
- Métricas do Supabase
- Uso de recursos do sistema
EOF

cat > webhooks/README.md << 'EOF'
# Webhooks Directory

Este diretório contém configurações e handlers para webhooks do TalkHub MCP Server.

## Webhooks Suportados

- **UCat/TalkHub**: `/webhook.talkhub.me/uchat`
- **WhatsApp**: `/webhook.talkhub.me/whatsapp`
- **Telegram**: `/webhook.talkhub.me/telegram`

## Configuração

Os webhooks são configurados através das variáveis de ambiente:

```bash
WEBHOOK_SECRET=seu_secret_seguro
PLATFORM_WEBHOOK_SECRET=secret_da_plataforma
```

## Testando Webhooks

Para testar localmente:

```bash
curl -X POST http://localhost:3004/uchat \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

## Logs

Os logs dos webhooks aparecem no serviço `talkhub-webhook`:

```bash
./deploy-talkhub.sh logs webhook
```
EOF

echo -e "${GREEN}✓ READMEs dos diretórios criados${NC}"

# Verificar estrutura final
echo -e "\n${BLUE}📋 Estrutura de arquivos criada:${NC}"
echo -e "${GREEN}✓ logs/.gitkeep${NC}"
echo -e "${GREEN}✓ monitoring/.gitkeep${NC}"
echo -e "${GREEN}✓ webhooks/.gitkeep${NC}"
echo -e "${GREEN}✓ .gitignore${NC}"
echo -e "${GREEN}✓ .dockerignore${NC}"
echo -e "${GREEN}✓ docker-compose.dev.yml${NC}"
echo -e "${GREEN}✓ .vscode/settings.json${NC}"
echo -e "${GREEN}✓ .vscode/launch.json${NC}"
echo -e "${GREEN}✓ .vscode/extensions.json${NC}"
echo -e "${GREEN}✓ logs/README.md${NC}"
echo -e "${GREEN}✓ monitoring/README.md${NC}"
echo -e "${GREEN}✓ webhooks/README.md${NC}"

echo -e "\n${GREEN}🎉 Todos os arquivos faltantes foram criados!${NC}"
echo -e "\n${YELLOW}📋 Próximos passos:${NC}"
echo -e "1. ${BLUE}npm install${NC} - Instalar dependências"
echo -e "2. ${BLUE}cp .env.example .env${NC} - Criar configuração"
echo -e "3. ${BLUE}./deploy-talkhub.sh secrets${NC} - Gerar secrets"
echo -e "4. ${BLUE}docker-compose -f docker-compose.dev.yml up${NC} - Testar localmente"

echo -e "\n${BLUE}🛠️  Ferramentas opcionais (development):${NC}"
echo -e "• Redis Commander: ${BLUE}http://localhost:8081${NC} (para visualizar dados do Redis)"
echo -e "• Adminer: ${BLUE}http://localhost:8080${NC} (para acessar Supabase diretamente)"
echo -e "Para usar as ferramentas: ${BLUE}docker-compose -f docker-compose.dev.yml --profile tools up${NC}"

echo -e "\n${GREEN}✅ Arquivos criados com sucesso!${NC}"