#!/bin/bash

# Script de deploy do TalkHub MCP Server
# Uso: ./deploy-talkhub.sh [build|deploy|full|init-supabase|status|logs|cleanup]

set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configurações
STACK_NAME="talkhub-mcp"
COMPOSE_FILE="docker-stack.yml"

# Banner do TalkHub
print_banner() {
    echo -e "${BLUE}"
    echo "████████╗ █████╗ ██╗     ██╗  ██╗██╗  ██╗██╗   ██╗██████╗ "
    echo "╚══██╔══╝██╔══██╗██║     ██║ ██╔╝██║  ██║██║   ██║██╔══██╗"
    echo "   ██║   ███████║██║     █████╔╝ ███████║██║   ██║██████╔╝"
    echo "   ██║   ██╔══██║██║     ██╔═██╗ ██╔══██║██║   ██║██╔══██╗"
    echo "   ██║   ██║  ██║███████╗██║  ██╗██║  ██║╚██████╔╝██████╔╝"
    echo "   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ "
    echo ""
    echo "        MCP Server - Otimização para Chatbots Conversacionais"
    echo -e "${NC}"
}

# Verificar se .env existe
check_env() {
    if [ ! -f .env ]; then
        echo -e "${RED}Erro: Arquivo .env não encontrado!${NC}"
        echo -e "${YELLOW}Crie o arquivo .env baseado no .env.example${NC}"
        echo "cp .env.example .env"
        echo "# Edite o .env com suas configurações"
        exit 1
    fi
}

# Carregar variáveis do .env
load_env() {
    echo -e "${YELLOW}Carregando variáveis de ambiente...${NC}"
    export $(grep -v '^#' .env | xargs)
}

# Verificar variáveis obrigatórias
check_required_vars() {
    required_vars=("GHCR_USER" "CR_PAT" "JWT_SECRET" "ADMIN_SECRET" "WEBHOOK_SECRET")
    for var in "${required_vars[@]}"; do
        if [ -z "${!var}" ]; then
            echo -e "${RED}Erro: Variável $var não está definida no .env${NC}"
            exit 1
        fi
    done
}

# Função para logging
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERRO: $1${NC}"
    exit 1
}

warning() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] AVISO: $1${NC}"
}

# Gerar secrets seguros
generate_secrets() {
    log "Gerando novos secrets para o .env..."
    
    # Backup do .env atual se existir
    if [ -f .env ]; then
        cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
        log "Backup do .env atual criado"
    fi
    
    # Gerar novos valores
    NEW_JWT_SECRET=$(openssl rand -hex 32)
    NEW_ADMIN_SECRET=$(openssl rand -hex 32)
    NEW_WEBHOOK_SECRET=$(openssl rand -hex 32)
    NEW_GRAFANA_PASSWORD=$(openssl rand -base64 16 | tr -d "=+/" | cut -c1-12)
    
    echo -e "${YELLOW}Novos secrets gerados:${NC}"
    echo "JWT_SECRET=$NEW_JWT_SECRET"
    echo "ADMIN_SECRET=$NEW_ADMIN_SECRET"
    echo "WEBHOOK_SECRET=$NEW_WEBHOOK_SECRET"
    echo "GRAFANA_PASSWORD=$NEW_GRAFANA_PASSWORD"
    echo -e "${YELLOW}Atualize seu arquivo .env com estes valores!${NC}"
}

# Inicializar Supabase
init_supabase() {
    log "Inicializando tabelas do Supabase..."
    
    if [ ! -f "scripts/init-supabase.js" ]; then
        error "Script init-supabase.js não encontrado!"
    fi
    
    # Instalar dependências se necessário
    if [ ! -d "node_modules" ]; then
        log "Instalando dependências..."
        npm install
    fi
    
    # Executar script de inicialização
    node scripts/init-supabase.js || error "Falha na inicialização do Supabase"
    
    log "Supabase inicializado com sucesso!"
}

# Função para build e push das imagens
build_and_push() {
    log "Fazendo login no GitHub Container Registry..."
    echo "$CR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin || error "Falha no login do GHCR"

    log "Construindo imagem do TalkHub MCP Server..."
    docker build -t ghcr.io/$GHCR_USER/talkhub-mcp-server:latest -f Dockerfile . || error "Falha no build da imagem principal"

    log "Construindo imagem do Webhook Handler..."
    docker build -t ghcr.io/$GHCR_USER/talkhub-webhook:latest -f Dockerfile.webhook . || error "Falha no build do webhook"

    log "Construindo imagem do Dashboard..."
    docker build -t ghcr.io/$GHCR_USER/talkhub-dashboard:latest -f Dockerfile.dashboard . || error "Falha no build do dashboard"

    log "Enviando imagens para o registry..."
    docker push ghcr.io/$GHCR_USER/talkhub-mcp-server:latest || error "Falha no push da imagem principal"
    docker push ghcr.io/$GHCR_USER/talkhub-webhook:latest || error "Falha no push do webhook"
    docker push ghcr.io/$GHCR_USER/talkhub-dashboard:latest || error "Falha no push do dashboard"

    log "Imagens enviadas com sucesso!"
}

# Função para preparar infraestrutura
prepare_infrastructure() {
    log "Preparando infraestrutura Docker Swarm..."

    # Verificar se está em um nó manager
    if ! docker node ls >/dev/null 2>&1; then
        error "Este comando deve ser executado em um nó manager do Docker Swarm"
    fi

    # Criar rede overlay (ignora erro se já existe)
    log "Criando rede overlay 'talkhub'..."
    docker network create --driver=overlay talkhub 2>/dev/null || log "Rede 'talkhub' já existe"

    # Criar volumes nomeados
    log "Criando volumes para persistência..."
    docker volume create talkhub_mcp_redis_data 2>/dev/null || log "Volume 'talkhub_mcp_redis_data' já existe"
    docker volume create talkhub_mcp_logs_data 2>/dev/null || log "Volume 'talkhub_mcp_logs_data' já existe"
    docker volume create talkhub_grafana_data 2>/dev/null || log "Volume 'talkhub_grafana_data' já existe"

    # Criar diretórios para configurações
    log "Criando diretórios de configuração..."
    mkdir -p monitoring logs webhooks

    # Criar configuração do Prometheus
    create_prometheus_config

    log "Infraestrutura preparada!"
}

# Criar configuração do Prometheus
create_prometheus_config() {
    log "Criando configuração do Prometheus..."
    
    cat > monitoring/prometheus.yml << EOF
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  # - "first_rules.yml"
  # - "second_rules.yml"

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'talkhub-mcp-server'
    static_configs:
      - targets: ['talkhub-mcp-server:3003']
    metrics_path: '/api/metrics'
    scrape_interval: 30s

  - job_name: 'redis'
    static_configs:
      - targets: ['redis:6379']

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']
EOF
}

# Função para fazer deploy da stack
deploy_stack() {
    log "Fazendo deploy da stack TalkHub MCP..."

    # Verificar se o arquivo compose existe
    if [ ! -f "$COMPOSE_FILE" ]; then
        error "Arquivo $COMPOSE_FILE não encontrado!"
    fi

    # Substituir placeholder do usuário GitHub no compose file
    sed -i "s/<SEU_USUARIO_GH>/$GHCR_USER/g" "$COMPOSE_FILE"

    # Deploy da stack
    docker stack deploy -c "$COMPOSE_FILE" --with-registry-auth "$STACK_NAME" || error "Falha no deploy da stack"

    log "Stack '$STACK_NAME' deployada com sucesso!"
    
    # Aguardar um pouco e mostrar status
    sleep 10
    log "Status dos serviços:"
    docker stack ps "$STACK_NAME"
}

# Função para verificar status
check_status() {
    log "Verificando status da stack TalkHub MCP..."
    
    echo -e "\n${YELLOW}=== STATUS DOS SERVIÇOS ===${NC}"
    docker service ls --filter label=com.docker.stack.namespace="$STACK_NAME"
    
    echo -e "\n${YELLOW}=== TASKS DA STACK ===${NC}"
    docker stack ps "$STACK_NAME"
    
    echo -e "\n${YELLOW}=== TESTANDO ENDPOINTS ===${NC}"
    sleep 15  # Aguardar containers iniciarem
    
    # Testar endpoints
    test_endpoints
}

# Testar endpoints da aplicação
test_endpoints() {
    local endpoints=(
        "https://mcp.talkhub.me/api/health:MCP Server Health"
        "https://webhook.talkhub.me/health:Webhook Handler"
        "https://dashboard.talkhub.me:Dashboard"
        "https://monitoring.talkhub.me:Grafana"
    )
    
    for endpoint in "${endpoints[@]}"; do
        url=$(echo $endpoint | cut -d: -f1)
        name=$(echo $endpoint | cut -d: -f2)
        
        echo -n "Testando $name... "
        if curl -f -s "$url" >/dev/null 2>&1; then
            echo -e "${GREEN}✓ OK${NC}"
        else
            echo -e "${RED}✗ Falhou${NC}"
        fi
    done
}

# Função para mostrar logs
show_logs() {
    local service="${1:-talkhub-mcp-server}"
    log "Exibindo logs do serviço: $service"
    
    case $service in
        "mcp"|"server")
            docker service logs --tail 50 -f ${STACK_NAME}_talkhub-mcp-server
            ;;
        "webhook")
            docker service logs --tail 50 -f ${STACK_NAME}_talkhub-webhook
            ;;
        "dashboard")
            docker service logs --tail 50 -f ${STACK_NAME}_talkhub-dashboard
            ;;
        "redis")
            docker service logs --tail 50 -f ${STACK_NAME}_redis
            ;;
        "all")
            echo -e "${YELLOW}Mostrando logs de todos os serviços (últimas 20 linhas cada):${NC}"
            echo -e "\n${BLUE}=== MCP SERVER ===${NC}"
            docker service logs --tail 20 ${STACK_NAME}_talkhub-mcp-server
            echo -e "\n${BLUE}=== WEBHOOK ===${NC}"
            docker service logs --tail 20 ${STACK_NAME}_talkhub-webhook
            echo -e "\n${BLUE}=== REDIS ===${NC}"
            docker service logs --tail 20 ${STACK_NAME}_redis
            ;;
        *)
            docker service logs --tail 50 -f ${STACK_NAME}_$service
            ;;
    esac
}

# Função para cleanup
cleanup() {
    echo -e "${YELLOW}Atenção: Esta operação irá remover a stack TalkHub MCP${NC}"
    read -p "Tem certeza? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log "Removendo stack TalkHub MCP..."
        docker stack rm "$STACK_NAME"
        
        log "Aguardando remoção completa..."
        sleep 15
        
        echo -e "${YELLOW}Deseja remover os volumes (dados serão perdidos)? (y/N): ${NC}"
        read -p "" -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            docker volume rm talkhub_mcp_redis_data talkhub_mcp_logs_data talkhub_grafana_data 2>/dev/null || true
            log "Volumes removidos"
        fi
        
        log "Cleanup concluído!"
    else
        log "Operação cancelada"
    fi
}

# Função para escalar serviços
scale_service() {
    local service="$1"
    local replicas="$2"
    
    if [ -z "$service" ] || [ -z "$replicas" ]; then
        error "Uso: scale <serviço> <número_de_réplicas>"
    fi
    
    log "Escalando $service para $replicas réplicas..."
    docker service scale ${STACK_NAME}_$service=$replicas
}

# Função para mostrar informações úteis
show_info() {
    echo -e "${BLUE}=== INFORMAÇÕES DO TALKHUB MCP SERVER ===${NC}"
    echo ""
    echo -e "${YELLOW}📍 Endpoints disponíveis:${NC}"
    echo "   🔗 MCP Server API: https://mcp.talkhub.me"
    echo "   🔗 Webhook Handler: https://webhook.talkhub.me"
    echo "   🔗 Dashboard: https://dashboard.talkhub.me"
    echo "   🔗 Monitoring: https://monitoring.talkhub.me"
    echo ""
    echo -e "${YELLOW}🛠️  Principais endpoints MCP:${NC}"
    echo "   GET  /api/health - Health check"
    echo "   GET  /api/v1/mcp/tools - Lista de ferramentas"
    echo "   POST /api/v1/mcp/create_chat_session - Criar sessão"
    echo "   GET  /api/v1/mcp/get_user_context/:userId - Contexto do usuário"
    echo "   POST /api/v1/mcp/save_conversation - Salvar conversa"
    echo "   PUT  /api/v1/mcp/update_user_profile - Atualizar perfil"
    echo "   GET  /api/v1/mcp/get_conversation_analytics - Analytics"
    echo ""
    echo -e "${YELLOW}📊 Comandos úteis:${NC}"
    echo "   ./deploy-talkhub.sh status - Ver status dos serviços"
    echo "   ./deploy-talkhub.sh logs mcp - Ver logs do MCP server"
    echo "   ./deploy-talkhub.sh logs all - Ver logs de todos os serviços"
    echo "   ./deploy-talkhub.sh scale talkhub-mcp-server 3 - Escalar para 3 réplicas"
    echo ""
}

# Menu principal
main() {
    print_banner
    
    case "${1:-help}" in
        "secrets")
            generate_secrets
            ;;
        "init-supabase")
            check_env
            load_env
            init_supabase
            ;;
        "build")
            check_env
            load_env
            check_required_vars
            build_and_push
            ;;
        "deploy")
            check_env
            load_env
            check_required_vars
            prepare_infrastructure
            deploy_stack
            check_status
            show_info
            ;;
        "full")
            check_env
            load_env
            check_required_vars
            init_supabase
            build_and_push
            prepare_infrastructure
            deploy_stack
            check_status
            show_info
            ;;
        "status")
            check_status
            ;;
        "logs")
            show_logs "${2:-mcp}"
            ;;
        "scale")
            scale_service "$2" "$3"
            ;;
        "cleanup")
            cleanup
            ;;
        "info")
            show_info
            ;;
        "help"|*)
            echo -e "${YELLOW}Uso: $0 [comando]${NC}"
            echo ""
            echo "Comandos disponíveis:"
            echo "  secrets       - Gera novos secrets seguros"
            echo "  init-supabase - Inicializa tabelas do Supabase"
            echo "  build         - Constrói e envia imagens para o registry"
            echo "  deploy        - Prepara infraestrutura e faz deploy"
            echo "  full          - Processo completo (init + build + deploy)"
            echo "  status        - Mostra status dos serviços"
            echo "  logs [serviço] - Exibe logs (mcp|webhook|dashboard|redis|all)"
            echo "  scale <serviço> <réplicas> - Escala um serviço"
            echo "  cleanup       - Remove a stack (com confirmação)"
            echo "  info          - Mostra informações úteis"
            echo "  help          - Mostra esta ajuda"
            echo ""
            echo -e "${YELLOW}Exemplo de uso completo:${NC}"
            echo "  1. cp .env.example .env"
            echo "  2. $0 secrets"
            echo "  3. # Edite o .env com os secrets gerados e suas configurações"
            echo "  4. $0 full"
            echo "  5. $0 status"
            echo ""
            echo -e "${YELLOW}Para integração com UCat/TalkHub:${NC}"
            echo "  • Configure o webhook: https://webhook.talkhub.me/uchat"
            echo "  • Use a API MCP: https://mcp.talkhub.me/api/v1/mcp/tools"
            echo "  • Monitore em: https://monitoring.talkhub.me"
            ;;
    esac
}

# Executar função principal
main "$@"

log "Operação concluída!"