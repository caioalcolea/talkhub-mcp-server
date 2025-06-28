# Dockerfile para TalkHub MCP Server
FROM node:18-alpine

# Informações do mantenedor
LABEL maintainer="TalkHub Team"
LABEL description="TalkHub MCP Server - Integração Supabase para Chatbots Conversacionais"
LABEL version="1.0.0"

# Criar usuário não-root para segurança
RUN addgroup -g 1001 -S talkhub && \
    adduser -S talkhub -u 1001

# Definir diretório de trabalho
WORKDIR /app

# Instalar dependências do sistema
RUN apk add --no-cache \
    curl \
    bash \
    && rm -rf /var/cache/apk/*

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar dependências da aplicação
RUN npm ci --only=production && \
    npm cache clean --force

# Copiar código fonte
COPY . .

# Criar diretório de logs
RUN mkdir -p logs && \
    chown -R talkhub:talkhub /app

# Mudar para usuário não-root
USER talkhub

# Expor porta
EXPOSE 3003

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3003/api/health || exit 1

# Comando de inicialização
CMD ["node", "server.js"]