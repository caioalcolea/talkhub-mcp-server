/*************************************************************************
 * TalkHub MCP Server - Integração com UCat/TalkHub                     *
 * Servidor MCP otimizado para chatbots conversacionais                  *
 *************************************************************************/
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');
const winston = require('winston');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3003;
const app = express();

/* ------------------------- Supabase Client --------------------------- */
const supabaseUrl = 'https://supatalk.talkhub.me';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzE1MDUwODAwLAogICJleHAiOiAxODcyODE3MjAwCn0.chLQyRz8PtQQCKYNrJvOfViDq769cZ226xHPNjAoGUc';

const supabase = createSupabaseClient(supabaseUrl, supabaseKey);

/* --------------------------- Logger ---------------------------------- */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ 
      filename: 'logs/app.log',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true
    })
  ]
});

/* ----------------------------- Redis --------------------------------- */
const redisClient = createClient({ 
  url: process.env.REDIS_URL || 'redis://redis:6379',
  retry_strategy: (times) => Math.min(times * 50, 2000)
});

redisClient.on('error', err => logger.error('Redis error', err));
redisClient.on('connect', () => logger.info('Redis connected'));

/* ------------------------- Supabase Setup ---------------------------- */
async function initSupabaseTables() {
  try {
    // Criar tabela para sessões de chat se não existir
    const { error: sessionsError } = await supabase.rpc('create_chat_sessions_table');
    
    // Criar tabela para conversas se não existir
    const { error: conversationsError } = await supabase.rpc('create_conversations_table');
    
    // Criar tabela para contexto do usuário
    const { error: contextError } = await supabase.rpc('create_user_context_table');
    
    logger.info('Supabase tables initialized successfully');
  } catch (error) {
    logger.warn('Supabase table initialization (tables may already exist):', error.message);
  }
}

/* --------------------------- Middlewares ----------------------------- */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
app.use(cors({ 
  origin: allowedOrigins, 
  credentials: true 
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000,
  max: process.env.RATE_LIMIT_MAX || 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString(),
    headers: {
      authorization: req.headers.authorization ? '[REDACTED]' : 'none',
      'x-webhook-secret': req.headers['x-webhook-secret'] ? '[REDACTED]' : 'none'
    }
  });
  next();
});

/* ------------------------- UCat Authentication ----------------------- */
const authenticateUCat = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const webhookSecret = req.headers['x-webhook-secret'];
  const customAuth = req.headers['x-talkhub-auth'];

  // Allow requests with valid bearer token
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    
    // Validate against webhook secret or JWT
    if (token === process.env.WEBHOOK_SECRET) {
      req.authenticated = true;
      req.authType = 'webhook_secret';
      return next();
    }
    
    // Try JWT validation
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      req.authenticated = true;
      req.authType = 'jwt';
      return next();
    } catch (err) {
      // Continue to other auth methods
    }
  }

  // Allow requests with webhook secret header
  if (webhookSecret === process.env.WEBHOOK_SECRET) {
    req.authenticated = true;
    req.authType = 'header_secret';
    return next();
  }

  // Allow requests with custom TalkHub auth
  if (customAuth === process.env.ADMIN_SECRET) {
    req.authenticated = true;
    req.authType = 'admin_secret';
    return next();
  }

  // For development/testing - allow unauthenticated requests if no auth configured
  if (!process.env.WEBHOOK_SECRET && !process.env.JWT_SECRET) {
    req.authenticated = false;
    req.authType = 'none';
    return next();
  }

  // Authentication required but not provided
  logger.warn('Unauthorized MCP request', {
    ip: req.ip,
    path: req.path,
    headers: {
      hasAuth: !!authHeader,
      hasWebhookSecret: !!webhookSecret,
      hasCustomAuth: !!customAuth
    }
  });

  return res.status(401).json({ 
    error: 'Authentication required',
    message: 'Please provide Bearer token, X-Webhook-Secret, or X-TalkHub-Auth header',
    supported_auth: ['Bearer JWT', 'Bearer webhook_secret', 'X-Webhook-Secret', 'X-TalkHub-Auth']
  });
};

/* ------------------------- Health Check ------------------------------ */
app.get('/api/health', async (req, res) => {
  const health = { 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: process.env.API_VERSION || 'v1',
    environment: process.env.NODE_ENV || 'development',
    integration: 'UCat/TalkHub MCP Server'
  };
  
  try {
    const { data, error } = await supabase.from('chat_sessions').select('count').limit(1);
    health.supabase = { status: 'connected' };
  } catch (e) {
    health.status = 'degraded';
    health.supabase = { status: 'error', message: e.message };
  }
  
  try {
    await redisClient.ping();
    health.redis = { status: 'connected' };
  } catch (e) {
    health.status = 'degraded';
    health.redis = { status: 'error', message: e.message };
  }
  
  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

/* ========================= UCat/TalkHub MCP API ========================= */

/**
 * UCat/TalkHub Compatible MCP Root Endpoint
 * UCat acessa diretamente a URL base para listar ferramentas
 */
app.get('/', authenticateUCat, (req, res) => {
  logger.info('UCat MCP server info request', {
    authType: req.authType,
    authenticated: req.authenticated,
    userAgent: req.get('User-Agent')
  });

  const mcpResponse = {
    // Informações do servidor MCP no formato padrão
    name: "TalkHub MCP Server",
    version: "1.0.0", 
    description: "Servidor MCP para chatbots conversacionais com contexto inteligente e analytics",
    protocol_version: "2024-11-05",
    capabilities: {
      tools: {},
      logging: {},
      prompts: {},
      resources: {}
    },
    
    // Ferramentas disponíveis no formato MCP padrão
    tools: [
      {
        name: "create_chat_session",
        description: "Cria uma nova sessão de chat para um usuário específico da plataforma",
        inputSchema: {
          type: "object",
          properties: {
            user_id: {
              type: "string",
              description: "ID único do usuário na plataforma (WhatsApp, Telegram, etc.)"
            },
            user_data: {
              type: "object",
              description: "Dados do usuário coletados (nome, telefone, email, etc.)",
              properties: {
                name: { type: "string" },
                phone: { type: "string" },
                email: { type: "string" },
                platform_data: { type: "object" }
              }
            },
            platform: {
              type: "string",
              description: "Plataforma de origem do usuário",
              enum: ["whatsapp", "telegram", "instagram", "facebook", "webchat", "api"]
            },
            metadata: {
              type: "object",
              description: "Metadados adicionais da sessão"
            }
          },
          required: ["user_id"]
        }
      },
      
      {
        name: "get_user_context",
        description: "Recupera o contexto histórico completo do usuário para personalizar respostas",
        inputSchema: {
          type: "object",
          properties: {
            user_id: {
              type: "string", 
              description: "ID único do usuário"
            },
            include_history: {
              type: "boolean",
              description: "Incluir histórico de conversas anteriores",
              default: true
            },
            context_depth: {
              type: "string",
              description: "Nível de detalhamento do contexto",
              enum: ["basic", "detailed", "full"],
              default: "detailed"
            },
            max_conversations: {
              type: "integer",
              description: "Número máximo de conversas anteriores a incluir",
              default: 5,
              minimum: 1,
              maximum: 20
            }
          },
          required: ["user_id"]
        }
      },
      
      {
        name: "save_conversation",
        description: "Salva uma conversa completa com análise automática de intenção e sentimento",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "ID da sessão de chat"
            },
            user_id: {
              type: "string", 
              description: "ID do usuário"
            },
            messages: {
              type: "array",
              description: "Array completo de mensagens da conversa",
              items: {
                type: "object",
                properties: {
                  role: { 
                    type: "string", 
                    enum: ["user", "assistant", "system"] 
                  },
                  content: { type: "string" },
                  timestamp: { type: "string", format: "date-time" },
                  metadata: { type: "object" }
                },
                required: ["role", "content", "timestamp"]
              }
            },
            outcome: {
              type: "string",
              description: "Resultado da conversa",
              enum: ["completed", "abandoned", "transferred", "escalated"]
            },
            satisfaction_score: {
              type: "number",
              description: "Pontuação de satisfação (1-5)",
              minimum: 1,
              maximum: 5
            }
          },
          required: ["session_id", "user_id", "messages"]
        }
      },
      
      {
        name: "update_user_profile", 
        description: "Atualiza ou cria perfil do usuário com informações coletadas durante conversas",
        inputSchema: {
          type: "object",
          properties: {
            user_id: {
              type: "string",
              description: "ID único do usuário"
            },
            profile_updates: {
              type: "object",
              description: "Dados do perfil a serem atualizados",
              properties: {
                name: { type: "string" },
                email: { type: "string", format: "email" },
                phone: { type: "string" },
                preferences: {
                  type: "object",
                  description: "Preferências do usuário"
                },
                tags: {
                  type: "array",
                  items: { type: "string" },
                  description: "Tags para categorização"
                },
                notes: {
                  type: "string",
                  description: "Notas adicionais sobre o usuário"
                }
              }
            },
            merge_strategy: {
              type: "string",
              description: "Como mesclar com dados existentes",
              enum: ["merge", "replace", "append"],
              default: "merge"
            }
          },
          required: ["user_id", "profile_updates"]
        }
      },
      
      {
        name: "get_conversation_analytics",
        description: "Retorna análises e insights das conversas para otimização do chatbot",
        inputSchema: {
          type: "object", 
          properties: {
            user_id: {
              type: "string",
              description: "ID do usuário específico (opcional)"
            },
            date_range: {
              type: "object",
              description: "Período para análise",
              properties: {
                start: { type: "string", format: "date-time" },
                end: { type: "string", format: "date-time" }
              }
            },
            metrics: {
              type: "array",
              description: "Métricas específicas a retornar",
              items: {
                type: "string",
                enum: [
                  "total_conversations",
                  "unique_users", 
                  "avg_response_time",
                  "intent_distribution",
                  "sentiment_analysis",
                  "completion_rate",
                  "satisfaction_scores",
                  "peak_hours",
                  "common_topics"
                ]
              },
              default: ["total_conversations", "intent_distribution", "sentiment_analysis"]
            },
            group_by: {
              type: "string",
              description: "Agrupar resultados por",
              enum: ["day", "week", "month", "platform"],
              default: "day"
            }
          }
        }
      },

      {
        name: "search_conversations",
        description: "Busca conversas por critérios específicos para análise ou suporte",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Termo de busca nas mensagens"
            },
            user_id: {
              type: "string", 
              description: "Filtrar por usuário específico"
            },
            intent: {
              type: "string",
              description: "Filtrar por intenção detectada"
            },
            sentiment: {
              type: "string",
              enum: ["positive", "negative", "neutral"],
              description: "Filtrar por sentimento"
            },
            date_range: {
              type: "object",
              properties: {
                start: { type: "string", format: "date-time" },
                end: { type: "string", format: "date-time" }
              }
            },
            limit: {
              type: "integer",
              default: 10,
              maximum: 100
            }
          }
        }
      }
    ]
  };

  res.json(mcpResponse);
});

/**
 * Endpoint MCP padrão para listagem de ferramentas (compatibilidade)
 */
app.get('/mcp/list_tools', authenticateUCat, (req, res) => {
  // Redirecionar para endpoint principal
  res.redirect(301, '/');
});

/**
 * UCat Tool Execution Endpoint (MCP padrão)
 * Endpoint para executar ferramentas MCP
 */
app.post('/mcp/call_tool', authenticateUCat, async (req, res) => {
  try {
    const { name, arguments: toolArgs = {} } = req.body;
    
    if (!name) {
      return res.status(400).json({
        error: 'tool name is required',
        available_tools: [
          'create_chat_session',
          'get_user_context', 
          'save_conversation',
          'update_user_profile',
          'get_conversation_analytics',
          'search_conversations'
        ]
      });
    }

    logger.info('MCP tool execution', {
      tool: name,
      authType: req.authType,
      hasArguments: Object.keys(toolArgs).length > 0
    });

    let result;
    
    switch (name) {
      case 'create_chat_session':
        result = await executeCreateChatSession(toolArgs);
        break;
      case 'get_user_context':
        result = await executeGetUserContext(toolArgs);
        break;
      case 'save_conversation':
        result = await executeSaveConversation(toolArgs);
        break;
      case 'update_user_profile':
        result = await executeUpdateUserProfile(toolArgs);
        break;
      case 'get_conversation_analytics':
        result = await executeGetConversationAnalytics(toolArgs);
        break;
      case 'search_conversations':
        result = await executeSearchConversations(toolArgs);
        break;
      default:
        return res.status(400).json({
          error: `Unknown tool: ${name}`,
          available_tools: [
            'create_chat_session',
            'get_user_context',
            'save_conversation', 
            'update_user_profile',
            'get_conversation_analytics',
            'search_conversations'
          ]
        });
    }

    // Formato de resposta MCP padrão
    res.json({
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      isError: false,
      _meta: {
        tool: name,
        timestamp: new Date().toISOString(),
        server: "TalkHub MCP"
      }
    });

  } catch (error) {
    logger.error('MCP tool execution error', {
      tool: req.body.name,
      error: error.message,
      stack: error.stack
    });

    // Formato de erro MCP padrão
    res.status(500).json({
      content: [
        {
          type: "text", 
          text: `Error executing tool: ${error.message}`
        }
      ],
      isError: true,
      _meta: {
        tool: req.body.name,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    });
  }
});

/* ========================= Legacy API Compatibility ========================= */

// Manter compatibilidade com API v1 existente
app.get('/api/v1/mcp/tools', (req, res) => {
  // Redirecionar para novo endpoint MCP
  res.redirect(301, '/');
});

// Compatibilidade com formato antigo de execução
app.post('/api/mcp/execute', authenticateUCat, async (req, res) => {
  // Converter formato antigo para novo
  const { tool_name, parameters = {} } = req.body;
  
  if (tool_name) {
    req.body.name = tool_name;
    req.body.arguments = parameters;
  }
  
  // Chamar endpoint MCP padrão
  return app._router.handle(
    { ...req, method: 'POST', url: '/mcp/call_tool' },
    res
  );
});

/* ========================= MCP Tool Implementations ========================= */

async function executeCreateChatSession(params) {
  const { user_id, user_data = {}, platform = 'unknown', metadata = {} } = params;
  
  if (!user_id) {
    throw new Error('user_id is required');
  }

  const session_id = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const sessionData = {
    session_id,
    user_id,
    user_data,
    platform,
    status: 'active',
    metadata,
    created_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('chat_sessions')
    .insert(sessionData)
    .select()
    .single();

  if (error) {
    logger.error('Error creating chat session:', error);
    throw new Error('Failed to create session: ' + error.message);
  }

  // Cache da sessão no Redis por 1 hora
  try {
    await redisClient.setEx(`session:${session_id}`, 3600, JSON.stringify(data));
  } catch (redisError) {
    logger.warn('Redis cache failed for session:', redisError.message);
  }
  
  logger.info('Chat session created', { session_id, user_id, platform });
  return data;
}

async function executeGetUserContext(params) {
  const { 
    user_id, 
    include_history = true, 
    context_depth = 'detailed',
    max_conversations = 5 
  } = params;
  
  if (!user_id) {
    throw new Error('user_id is required');
  }

  // Tentar buscar do cache primeiro
  let cachedContext;
  try {
    const cached = await redisClient.get(`context:${user_id}`);
    if (cached) {
      cachedContext = JSON.parse(cached);
    }
  } catch (redisError) {
    logger.warn('Redis cache read failed:', redisError.message);
  }

  // Buscar perfil do usuário
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', user_id)
    .single();

  let context = {
    user_id: user_id,
    profile: profile || {},
    has_history: false,
    recent_conversations: [],
    preferences: profile?.preferences || {},
    interaction_stats: profile?.interaction_stats || {},
    context_depth: context_depth,
    cached_at: cachedContext?.cached_at || null
  };

  if (include_history) {
    // Buscar conversas recentes
    const { data: conversations, error: convError } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(max_conversations);

    if (conversations && conversations.length > 0) {
      context.has_history = true;
      context.recent_conversations = conversations;
      
      // Análise de padrões de interação
      context.interaction_patterns = analyzeInteractionPatterns(conversations);
      
      if (context_depth === 'full') {
        context.conversation_summary = generateConversationSummary(conversations);
        context.detected_intents = extractCommonIntents(conversations);
        context.preferred_topics = extractPreferredTopics(conversations);
      }
    }
  }

  // Buscar contexto adicional
  if (context_depth !== 'basic') {
    const { data: userContext } = await supabase
      .from('user_context')
      .select('*')
      .eq('user_id', user_id)
      .gt('relevance_score', 0.3)
      .order('relevance_score', { ascending: false })
      .limit(10);

    if (userContext) {
      context.additional_context = userContext;
    }
  }

  // Cache do contexto por 10 minutos
  try {
    context.cached_at = new Date().toISOString();
    await redisClient.setEx(`context:${user_id}`, 600, JSON.stringify(context));
  } catch (redisError) {
    logger.warn('Redis cache write failed:', redisError.message);
  }

  return context;
}

async function executeSaveConversation(params) {
  const { 
    session_id, 
    user_id, 
    messages, 
    outcome = 'completed',
    satisfaction_score = null 
  } = params;
  
  if (!session_id || !user_id || !messages) {
    throw new Error('session_id, user_id, and messages are required');
  }

  const conversation_id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Análise automática de sentimento e intenção
  const analysisResult = await analyzeConversation(messages);
  
  const conversationData = {
    conversation_id,
    session_id,
    user_id,
    messages,
    intent_analysis: analysisResult,
    metadata: {
      message_count: messages.length,
      duration: calculateConversationDuration(messages),
      outcome: outcome,
      satisfaction_score: satisfaction_score,
      completion_status: outcome
    },
    created_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('conversations')
    .insert(conversationData)
    .select()
    .single();

  if (error) {
    logger.error('Error saving conversation:', error);
    throw new Error('Failed to save conversation: ' + error.message);
  }

  // Atualizar sessão como concluída
  await supabase
    .from('chat_sessions')
    .update({ 
      status: outcome === 'completed' ? 'completed' : 'active',
      updated_at: new Date().toISOString() 
    })
    .eq('session_id', session_id);

  // Invalidar cache do contexto do usuário
  try {
    await redisClient.del(`context:${user_id}`);
  } catch (redisError) {
    logger.warn('Redis cache invalidation failed:', redisError.message);
  }

  logger.info('Conversation saved', { conversation_id, session_id, user_id, outcome });
  return data;
}

async function executeUpdateUserProfile(params) {
  const { user_id, profile_updates, merge_strategy = 'merge' } = params;
  
  if (!user_id || !profile_updates) {
    throw new Error('user_id and profile_updates are required');
  }

  let finalProfileData = { ...profile_updates };

  if (merge_strategy === 'merge') {
    // Buscar perfil existente
    const { data: existing } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', user_id)
      .single();

    if (existing) {
      finalProfileData = {
        ...existing,
        ...profile_updates,
        preferences: { ...existing.preferences, ...profile_updates.preferences },
        tags: merge_strategy === 'append' && existing.tags ? 
              [...existing.tags, ...(profile_updates.tags || [])] : 
              profile_updates.tags || existing.tags
      };
    }
  }

  const { data, error } = await supabase
    .from('user_profiles')
    .upsert({
      user_id,
      ...finalProfileData,
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    logger.error('Error updating user profile:', error);
    throw new Error('Failed to update profile: ' + error.message);
  }

  // Invalidar cache do contexto
  try {
    await redisClient.del(`context:${user_id}`);
  } catch (redisError) {
    logger.warn('Redis cache invalidation failed:', redisError.message);
  }

  logger.info('User profile updated', { user_id, merge_strategy });
  return data;
}

async function executeGetConversationAnalytics(params) {
  const { user_id, date_range, metrics = [], group_by = 'day' } = params;
  
  let query = supabase.from('conversations').select('*');
  
  if (user_id) {
    query = query.eq('user_id', user_id);
  }
  
  if (date_range) {
    if (date_range.start) {
      query = query.gte('created_at', date_range.start);
    }
    if (date_range.end) {
      query = query.lte('created_at', date_range.end);
    }
  }

  const { data: conversations, error } = await query;

  if (error) {
    logger.error('Error fetching analytics:', error);
    throw new Error('Failed to fetch analytics: ' + error.message);
  }

  const analytics = {
    total_conversations: conversations.length,
    unique_users: [...new Set(conversations.map(c => c.user_id))].length,
    date_range: date_range || { start: null, end: null },
    group_by: group_by
  };

  // Calcular métricas solicitadas
  if (metrics.length === 0 || metrics.includes('intent_distribution')) {
    analytics.intent_distribution = getIntentDistribution(conversations);
  }

  if (metrics.length === 0 || metrics.includes('sentiment_analysis')) {
    analytics.sentiment_analysis = getSentimentAnalysis(conversations);
  }

  if (metrics.includes('avg_response_time')) {
    analytics.avg_response_time = calculateAvgResponseTime(conversations);
  }

  if (metrics.includes('completion_rate')) {
    analytics.completion_rate = getCompletionRate(conversations);
  }

  if (metrics.includes('satisfaction_scores')) {
    analytics.satisfaction_scores = getSatisfactionScores(conversations);
  }

  if (metrics.includes('peak_hours')) {
    analytics.peak_hours = getPeakHours(conversations);
  }

  if (metrics.includes('common_topics')) {
    analytics.common_topics = getCommonTopics(conversations);
  }

  return analytics;
}

async function executeSearchConversations(params) {
  const { query, user_id, intent, sentiment, date_range, limit = 10 } = params;
  
  let dbQuery = supabase.from('conversations').select('*');
  
  if (user_id) {
    dbQuery = dbQuery.eq('user_id', user_id);
  }
  
  if (intent) {
    dbQuery = dbQuery.contains('intent_analysis', { intent: intent });
  }
  
  if (sentiment) {
    dbQuery = dbQuery.contains('intent_analysis', { sentiment: sentiment });
  }
  
  if (date_range) {
    if (date_range.start) {
      dbQuery = dbQuery.gte('created_at', date_range.start);
    }
    if (date_range.end) {
      dbQuery = dbQuery.lte('created_at', date_range.end);
    }
  }
  
  dbQuery = dbQuery.order('created_at', { ascending: false }).limit(limit);

  const { data: conversations, error } = await dbQuery;

  if (error) {
    logger.error('Error searching conversations:', error);
    throw new Error('Failed to search conversations: ' + error.message);
  }

  // Se há query de texto, filtrar mensagens que contenham o termo
  let filteredConversations = conversations;
  if (query) {
    filteredConversations = conversations.filter(conv => {
      const messageText = conv.messages.map(m => m.content).join(' ').toLowerCase();
      return messageText.includes(query.toLowerCase());
    });
  }

  return {
    results: filteredConversations,
    total_found: filteredConversations.length,
    query_params: params,
    timestamp: new Date().toISOString()
  };
}

/* ========================= Legacy API Compatibility ========================= */

// Manter compatibilidade com API v1 existente
app.get('/api/v1/mcp/tools', (req, res) => {
  // Redirecionar para novo endpoint UCat
  res.redirect(301, '/api/mcp');
});

// Endpoints v1 originais mantidos para compatibilidade
app.post('/api/v1/mcp/create_chat_session', async (req, res) => {
  try {
    const result = await executeCreateChatSession(req.body);
    res.status(201).json(result);
  } catch (error) {
    logger.error('Error in v1 create_chat_session:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/mcp/get_user_context/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { include_history = 'true' } = req.query;
    
    const result = await executeGetUserContext({
      user_id: userId,
      include_history: include_history === 'true',
      context_depth: 'detailed'
    });
    
    res.json(result);
  } catch (error) {
    logger.error('Error in v1 get_user_context:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/mcp/save_conversation', async (req, res) => {
  try {
    const result = await executeSaveConversation(req.body);
    res.json(result);
  } catch (error) {
    logger.error('Error in v1 save_conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/v1/mcp/update_user_profile', async (req, res) => {
  try {
    const result = await executeUpdateUserProfile(req.body);
    res.json(result);
  } catch (error) {
    logger.error('Error in v1 update_user_profile:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/mcp/get_conversation_analytics', async (req, res) => {
  try {
    const result = await executeGetConversationAnalytics(req.query);
    res.json(result);
  } catch (error) {
    logger.error('Error in v1 get_conversation_analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

/* ========================= Helper Functions Enhanced ========================= */

function analyzeInteractionPatterns(conversations) {
  if (!conversations || conversations.length === 0) return {};
  
  const patterns = {
    avg_messages_per_conversation: 0,
    most_active_hours: [],
    conversation_frequency: 'low',
    response_patterns: {},
    engagement_score: 0
  };
  
  // Calcular média de mensagens
  const totalMessages = conversations.reduce((acc, conv) => acc + conv.messages.length, 0);
  patterns.avg_messages_per_conversation = totalMessages / conversations.length;
  
  // Analisar horários mais ativos
  const hourCounts = {};
  conversations.forEach(conv => {
    const hour = new Date(conv.created_at).getHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
  });
  
  patterns.most_active_hours = Object.entries(hourCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 3)
    .map(([hour]) => parseInt(hour));
  
  // Determinar frequência de conversas
  const daysSinceFirst = (new Date() - new Date(conversations[conversations.length - 1].created_at)) / (1000 * 60 * 60 * 24);
  const frequency = conversations.length / daysSinceFirst;
  
  if (frequency > 1) patterns.conversation_frequency = 'high';
  else if (frequency > 0.3) patterns.conversation_frequency = 'medium';
  else patterns.conversation_frequency = 'low';
  
  // Score de engajamento baseado em vários fatores
  patterns.engagement_score = Math.min(100, 
    (patterns.avg_messages_per_conversation * 10) + 
    (conversations.length * 2) + 
    (frequency * 20)
  );
  
  return patterns;
}

function generateConversationSummary(conversations) {
  if (!conversations || conversations.length === 0) return {};
  
  const summary = {
    total_conversations: conversations.length,
    date_range: {
      first: conversations[conversations.length - 1].created_at,
      last: conversations[0].created_at
    },
    topics_discussed: [],
    resolution_rate: 0,
    avg_satisfaction: 0
  };
  
  // Extrair tópicos mais discutidos
  const allMessages = conversations.flatMap(conv => conv.messages.map(m => m.content));
  summary.topics_discussed = extractTopicsFromMessages(allMessages);
  
  // Calcular taxa de resolução
  const resolvedConversations = conversations.filter(conv => 
    conv.metadata?.outcome === 'completed' || 
    conv.metadata?.completion_status === 'completed'
  );
  summary.resolution_rate = (resolvedConversations.length / conversations.length) * 100;
  
  // Satisfação média
  const satisfactionScores = conversations
    .map(conv => conv.metadata?.satisfaction_score)
    .filter(score => score != null);
  
  if (satisfactionScores.length > 0) {
    summary.avg_satisfaction = satisfactionScores.reduce((a, b) => a + b, 0) / satisfactionScores.length;
  }
  
  return summary;
}

function extractCommonIntents(conversations) {
  const intentCounts = {};
  
  conversations.forEach(conv => {
    const intent = conv.intent_analysis?.intent || 'unknown';
    intentCounts[intent] = (intentCounts[intent] || 0) + 1;
  });
  
  return Object.entries(intentCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([intent, count]) => ({ intent, count, percentage: (count / conversations.length) * 100 }));
}

function extractPreferredTopics(conversations) {
  const topicCounts = {};
  
  conversations.forEach(conv => {
    const topics = conv.intent_analysis?.topics || ['general'];
    topics.forEach(topic => {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    });
  });
  
  return Object.entries(topicCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, count }));
}

function extractTopicsFromMessages(messages) {
  const commonTopics = {
    'suporte': ['ajuda', 'problema', 'suporte', 'dúvida', 'erro'],
    'vendas': ['comprar', 'preço', 'valor', 'produto', 'venda'],
    'informações': ['informação', 'saber', 'como', 'quando', 'onde'],
    'reclamação': ['reclamação', 'insatisfeito', 'cancelar', 'problema'],
    'elogios': ['obrigado', 'parabéns', 'excelente', 'ótimo', 'bom']
  };
  
  const topicCounts = {};
  const text = messages.join(' ').toLowerCase();
  
  Object.entries(commonTopics).forEach(([topic, keywords]) => {
    const count = keywords.reduce((acc, keyword) => {
      return acc + (text.split(keyword).length - 1);
    }, 0);
    if (count > 0) {
      topicCounts[topic] = count;
    }
  });
  
  return Object.entries(topicCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));
}

function calculateAvgResponseTime(conversations) {
  const responseTimes = [];
  
  conversations.forEach(conv => {
    const messages = conv.messages || [];
    for (let i = 1; i < messages.length; i++) {
      const prev = new Date(messages[i-1].timestamp);
      const curr = new Date(messages[i].timestamp);
      const diff = (curr - prev) / 1000; // segundos
      
      if (diff > 0 && diff < 3600) { // Ignorar tempos > 1 hora
        responseTimes.push(diff);
      }
    }
  });
  
  if (responseTimes.length === 0) return 0;
  
  const avgSeconds = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
  return Math.round(avgSeconds);
}

function calculateConversationDuration(messages) {
  if (messages.length < 2) return 0;
  const first = new Date(messages[0].timestamp);
  const last = new Date(messages[messages.length - 1].timestamp);
  return Math.round((last - first) / 1000); // duration in seconds
}

async function analyzeConversation(messages) {
  // Análise aprimorada de sentimento e intenção
  const text = messages.map(m => m.content).join(' ');
  
  return {
    sentiment: analyzeSentiment(text),
    intent: detectIntent(text),
    topics: extractTopics(text),
    confidence: calculateAnalysisConfidence(text, messages),
    message_count: messages.length,
    user_engagement: calculateUserEngagement(messages)
  };
}

function calculateAnalysisConfidence(text, messages) {
  let confidence = 0.5; // Base confidence
  
  // Mais mensagens = maior confiança
  if (messages.length > 5) confidence += 0.2;
  if (messages.length > 10) confidence += 0.1;
  
  // Texto mais longo = maior confiança
  if (text.length > 100) confidence += 0.1;
  if (text.length > 500) confidence += 0.1;
  
  return Math.min(0.95, confidence);
}

function calculateUserEngagement(messages) {
  const userMessages = messages.filter(m => m.role === 'user');
  const totalWords = userMessages.reduce((acc, m) => acc + m.content.split(' ').length, 0);
  
  return {
    user_message_count: userMessages.length,
    avg_words_per_message: userMessages.length > 0 ? totalWords / userMessages.length : 0,
    engagement_level: userMessages.length > 5 ? 'high' : userMessages.length > 2 ? 'medium' : 'low'
  };
}

function analyzeSentiment(text) {
  // Análise de sentimento aprimorada em português
  const positiveWords = [
    'bom', 'ótimo', 'excelente', 'obrigado', 'perfeito', 'maravilhoso',
    'fantástico', 'adorei', 'amei', 'gostei', 'satisfeito', 'feliz',
    'parabéns', 'legal', 'incrível', 'show', 'top', 'demais'
  ];
  
  const negativeWords = [
    'ruim', 'péssimo', 'problema', 'erro', 'frustrado', 'irritado',
    'chateado', 'insatisfeito', 'horrível', 'odiei', 'detestei',
    'cancelar', 'reclamar', 'absurdo', 'revoltante', 'inaceitável'
  ];
  
  const words = text.toLowerCase().split(/\s+/);
  const positive = words.filter(w => positiveWords.includes(w)).length;
  const negative = words.filter(w => negativeWords.includes(w)).length;
  
  const score = (positive - negative) / words.length;
  
  if (score > 0.01) return 'positive';
  if (score < -0.01) return 'negative';
  return 'neutral';
}

function detectIntent(text) {
  // Detecção de intenção aprimorada
  const intents = {
    'support': ['ajuda', 'problema', 'suporte', 'dúvida', 'erro', 'bug', 'falha', 'não funciona'],
    'purchase': ['comprar', 'preço', 'valor', 'produto', 'venda', 'carrinho', 'pagamento', 'checkout'],
    'information': ['informação', 'saber', 'como', 'quando', 'onde', 'que horas', 'funciona'],
    'complaint': ['reclamação', 'insatisfeito', 'problema', 'cancelar', 'reembolso', 'devolver'],
    'compliment': ['obrigado', 'parabéns', 'excelente', 'ótimo', 'bom trabalho', 'satisfeito'],
    'booking': ['agendar', 'marcar', 'reservar', 'horário', 'consulta', 'agendamento'],
    'cancellation': ['cancelar', 'desistir', 'não quero', 'mudei de ideia', 'anular']
  };
  
  const words = text.toLowerCase().split(/\s+/);
  const intentScores = {};
  
  Object.entries(intents).forEach(([intent, keywords]) => {
    const score = keywords.reduce((acc, keyword) => {
      const keywordWords = keyword.split(' ');
      if (keywordWords.length === 1) {
        return acc + (words.includes(keyword) ? 1 : 0);
      } else {
        // Busca por frases
        return acc + (text.toLowerCase().includes(keyword) ? 2 : 0);
      }
    }, 0);
    
    if (score > 0) {
      intentScores[intent] = score;
    }
  });
  
  if (Object.keys(intentScores).length === 0) return 'unknown';
  
  return Object.entries(intentScores)
    .sort(([,a], [,b]) => b - a)[0][0];
}

function extractTopics(text) {
  // Extração de tópicos mais sofisticada
  const topicKeywords = {
    'produto': ['produto', 'item', 'mercadoria', 'artigo'],
    'entrega': ['entrega', 'envio', 'frete', 'correios', 'transportadora'],
    'pagamento': ['pagamento', 'pagar', 'cartão', 'pix', 'boleto', 'dinheiro'],
    'conta': ['conta', 'perfil', 'login', 'senha', 'cadastro', 'registro'],
    'técnico': ['técnico', 'funciona', 'erro', 'bug', 'sistema', 'app'],
    'atendimento': ['atendimento', 'atendente', 'suporte', 'help', 'ajuda']
  };
  
  const words = text.toLowerCase().split(/\s+/);
  const detectedTopics = [];
  
  Object.entries(topicKeywords).forEach(([topic, keywords]) => {
    const hasKeyword = keywords.some(keyword => words.includes(keyword));
    if (hasKeyword) {
      detectedTopics.push(topic);
    }
  });
  
  return detectedTopics.length > 0 ? detectedTopics : ['general'];
}

function getIntentDistribution(conversations) {
  const intents = {};
  conversations.forEach(conv => {
    const intent = conv.intent_analysis?.intent || 'unknown';
    intents[intent] = (intents[intent] || 0) + 1;
  });
  return intents;
}

function getSentimentAnalysis(conversations) {
  const sentiments = {};
  conversations.forEach(conv => {
    const sentiment = conv.intent_analysis?.sentiment || 'neutral';
    sentiments[sentiment] = (sentiments[sentiment] || 0) + 1;
  });
  return sentiments;
}

function getPeakHours(conversations) {
  const hours = {};
  conversations.forEach(conv => {
    const hour = new Date(conv.created_at).getHours();
    hours[hour] = (hours[hour] || 0) + 1;
  });
  return hours;
}

function getCompletionRate(conversations) {
  const completed = conversations.filter(c => 
    c.metadata?.completion_status === 'completed' || 
    c.metadata?.outcome === 'completed'
  ).length;
  return conversations.length > 0 ? (completed / conversations.length) * 100 : 0;
}

function getSatisfactionScores(conversations) {
  const scores = conversations
    .map(c => c.metadata?.satisfaction_score)
    .filter(score => score != null);
    
  if (scores.length === 0) return { avg: 0, count: 0, distribution: {} };
  
  const distribution = {};
  scores.forEach(score => {
    distribution[score] = (distribution[score] || 0) + 1;
  });
  
  return {
    avg: scores.reduce((a, b) => a + b, 0) / scores.length,
    count: scores.length,
    distribution: distribution
  };
}

function getCommonTopics(conversations) {
  const topicCounts = {};
  
  conversations.forEach(conv => {
    const topics = conv.intent_analysis?.topics || ['general'];
    topics.forEach(topic => {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    });
  });
  
  return Object.entries(topicCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10)
    .map(([topic, count]) => ({ 
      topic, 
      count, 
      percentage: (count / conversations.length) * 100 
    }));
}

// Rota para gerar token de autenticação
app.post('/api/v1/auth/token', (req, res) => {
  const { username, admin_secret } = req.body;
  
  if (admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  
  const token = jwt.sign(
    { username, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
  
  res.json({ token, expires_in: '24h' });
});

/* ========================= UCat Integration Test Endpoints ========================= */

/**
 * Endpoint de teste para validação UCat
 */
app.get('/mcp/test', authenticateUCat, (req, res) => {
  res.json({
    message: 'TalkHub MCP Server - UCat Integration Ready!',
    timestamp: new Date().toISOString(),
    auth_type: req.authType,
    authenticated: req.authenticated,
    mcp_endpoints: {
      list_tools: '/',
      call_tool: '/mcp/call_tool',
      health: '/api/health',
      test: '/mcp/test'
    },
    sample_usage: {
      list_tools: {
        method: 'GET',
        url: 'https://mcp.talkhub.me/',
        headers: {
          'Authorization': 'Bearer YOUR_TOKEN'
        }
      },
      call_tool: {
        method: 'POST',
        url: 'https://mcp.talkhub.me/mcp/call_tool',
        headers: {
          'Authorization': 'Bearer YOUR_TOKEN',
          'Content-Type': 'application/json'
        },
        body: {
          name: 'create_chat_session',
          arguments: {
            user_id: 'test_user_123',
            platform: 'whatsapp',
            user_data: { name: 'João', phone: '+5511999999999' }
          }
        }
      }
    }
  });
});

/**
 * Endpoint de métricas Prometheus
 */
app.get('/api/metrics', async (req, res) => {
  try {
    // Buscar métricas básicas
    const { data: sessions } = await supabase
      .from('chat_sessions')
      .select('status', { count: 'exact' });
    
    const { data: conversations } = await supabase
      .from('conversations')
      .select('created_at', { count: 'exact' });

    const activeSessions = sessions?.filter(s => s.status === 'active').length || 0;
    const totalConversations = conversations?.length || 0;

    const metrics = `
# HELP talkhub_active_sessions Number of active chat sessions
# TYPE talkhub_active_sessions gauge
talkhub_active_sessions ${activeSessions}

# HELP talkhub_total_conversations Total number of conversations
# TYPE talkhub_total_conversations counter
talkhub_total_conversations ${totalConversations}

# HELP talkhub_uptime_seconds Server uptime in seconds
# TYPE talkhub_uptime_seconds counter
talkhub_uptime_seconds ${Math.floor(process.uptime())}

# HELP talkhub_memory_usage_bytes Memory usage in bytes
# TYPE talkhub_memory_usage_bytes gauge
talkhub_memory_usage_bytes ${process.memoryUsage().heapUsed}
    `.trim();

    res.set('Content-Type', 'text/plain');
    res.send(metrics);
  } catch (error) {
    logger.error('Error generating metrics:', error);
    res.status(500).send('# Error generating metrics');
  }
});

/* --------------------------- Error Handlers -------------------------- */

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    message: 'The requested endpoint does not exist',
    path: req.originalUrl,
    available_endpoints: {
      mcp: '/api/mcp',
      execute: '/api/mcp/execute', 
      test: '/api/mcp/test',
      health: '/api/health',
      metrics: '/api/metrics'
    }
  });
});

// Error handler
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

/* --------------------------- Start Server ---------------------------- */
(async () => {
  try {
    // Conectar ao Redis
    await redisClient.connect();
    logger.info('Redis connected successfully');
    
    // Inicializar tabelas do Supabase
    await initSupabaseTables();
    
    // Iniciar servidor
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`✅ TalkHub MCP Server running on port ${PORT}`);
      logger.info(`🔗 Supabase integration: ${supabaseUrl}`);
      logger.info(`📊 Health check: http://localhost:${PORT}/api/health`);
      logger.info(`🛠️  MCP Server Root: http://localhost:${PORT}/`);
      logger.info(`⚡ MCP Call Tool: http://localhost:${PORT}/mcp/call_tool`);
      logger.info(`🧪 MCP Test: http://localhost:${PORT}/mcp/test`);
      logger.info(`📈 Metrics: http://localhost:${PORT}/api/metrics`);
      logger.info(`🎯 UCat Integration: Use https://mcp.talkhub.me/ as MCP Server URL`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await redisClient.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await redisClient.disconnect();
  process.exit(0);
});