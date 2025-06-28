/*************************************************************************
 * TalkHub MCP Server - Integração com Supabase                        *
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
    timestamp: new Date().toISOString()
  });
  next();
});

/* ------------------------- Health Check ------------------------------ */
app.get('/api/health', async (req, res) => {
  const health = { 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: process.env.API_VERSION || 'v1',
    environment: process.env.NODE_ENV || 'development'
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

/* ----------------------------- MCP API ------------------------------- */

// Middleware de autenticação JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Endpoint de teste
app.get('/api/v1/test', (req, res) => {
  res.json({ 
    message: 'TalkHub MCP Server is running!', 
    timestamp: new Date().toISOString(),
    version: process.env.API_VERSION || 'v1',
    integration: 'Supabase'
  });
});

// Lista de ferramentas MCP disponíveis
app.get('/api/v1/mcp/tools', (req, res) => {
  const tools = [
    {
      name: 'create_chat_session',
      description: 'Cria uma nova sessão de chat para um usuário',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'ID único do usuário' },
          user_data: { type: 'object', description: 'Dados do usuário (nome, telefone, etc.)' },
          platform: { type: 'string', description: 'Plataforma de origem (whatsapp, telegram, etc.)' }
        },
        required: ['user_id']
      }
    },
    {
      name: 'get_user_context',
      description: 'Busca o contexto histórico do usuário para personalizar respostas',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'ID único do usuário' },
          include_history: { type: 'boolean', description: 'Incluir histórico de conversas' }
        },
        required: ['user_id']
      }
    },
    {
      name: 'save_conversation',
      description: 'Salva uma conversa completa com análise de intenção',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'ID da sessão' },
          user_id: { type: 'string', description: 'ID do usuário' },
          messages: { type: 'array', description: 'Array de mensagens da conversa' },
          intent_analysis: { type: 'object', description: 'Análise de intenção da conversa' },
          metadata: { type: 'object', description: 'Metadados adicionais' }
        },
        required: ['session_id', 'user_id', 'messages']
      }
    },
    {
      name: 'update_user_profile',
      description: 'Atualiza o perfil do usuário com informações coletadas durante a conversa',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'ID único do usuário' },
          profile_data: { type: 'object', description: 'Dados do perfil a serem atualizados' }
        },
        required: ['user_id', 'profile_data']
      }
    },
    {
      name: 'get_conversation_analytics',
      description: 'Retorna análises das conversas para insights do chatbot',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'ID do usuário (opcional)' },
          date_range: { type: 'object', description: 'Período para análise' },
          metrics: { type: 'array', description: 'Métricas específicas a retornar' }
        }
      }
    }
  ];
  
  res.json({ tools });
});

// Criar sessão de chat
app.post('/api/v1/mcp/create_chat_session', async (req, res) => {
  try {
    const { user_id, user_data = {}, platform = 'unknown' } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const session_id = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({
        session_id,
        user_id,
        user_data,
        platform,
        status: 'active',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      logger.error('Error creating chat session:', error);
      return res.status(500).json({ error: 'Failed to create session' });
    }

    // Cache da sessão no Redis
    await redisClient.setEx(`session:${session_id}`, 3600, JSON.stringify(data));
    
    logger.info('Chat session created:', { session_id, user_id });
    res.status(201).json(data);
  } catch (error) {
    logger.error('Error in create_chat_session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Buscar contexto do usuário
app.get('/api/v1/mcp/get_user_context/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { include_history = false } = req.query;
    
    // Buscar perfil do usuário
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();

    let context = {
      user_id: userId,
      profile: profile || {},
      has_history: false,
      recent_conversations: [],
      preferences: {},
      interaction_stats: {}
    };

    if (include_history) {
      // Buscar conversas recentes
      const { data: conversations, error: convError } = await supabase
        .from('conversations')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (conversations && conversations.length > 0) {
        context.has_history = true;
        context.recent_conversations = conversations;
        
        // Análise de padrões de interação
        context.interaction_stats = {
          total_conversations: conversations.length,
          avg_response_time: calculateAvgResponseTime(conversations),
          preferred_topics: extractPreferredTopics(conversations),
          last_interaction: conversations[0].created_at
        };
      }
    }

    res.json(context);
  } catch (error) {
    logger.error('Error getting user context:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Salvar conversa
app.post('/api/v1/mcp/save_conversation', async (req, res) => {
  try {
    const { session_id, user_id, messages, intent_analysis = {}, metadata = {} } = req.body;
    
    if (!session_id || !user_id || !messages) {
      return res.status(400).json({ error: 'session_id, user_id, and messages are required' });
    }

    const conversation_id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Análise automática de sentimento e intenção
    const analysisResult = await analyzeConversation(messages);
    
    const { data, error } = await supabase
      .from('conversations')
      .insert({
        conversation_id,
        session_id,
        user_id,
        messages,
        intent_analysis: { ...intent_analysis, ...analysisResult },
        metadata: {
          ...metadata,
          message_count: messages.length,
          duration: calculateConversationDuration(messages),
          completion_status: 'completed'
        },
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      logger.error('Error saving conversation:', error);
      return res.status(500).json({ error: 'Failed to save conversation' });
    }

    // Atualizar sessão como concluída
    await supabase
      .from('chat_sessions')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('session_id', session_id);

    logger.info('Conversation saved:', { conversation_id, session_id, user_id });
    res.json(data);
  } catch (error) {
    logger.error('Error in save_conversation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Atualizar perfil do usuário
app.put('/api/v1/mcp/update_user_profile', async (req, res) => {
  try {
    const { user_id, profile_data } = req.body;
    
    if (!user_id || !profile_data) {
      return res.status(400).json({ error: 'user_id and profile_data are required' });
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .upsert({
        user_id,
        ...profile_data,
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      logger.error('Error updating user profile:', error);
      return res.status(500).json({ error: 'Failed to update profile' });
    }

    logger.info('User profile updated:', { user_id });
    res.json(data);
  } catch (error) {
    logger.error('Error in update_user_profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Analytics de conversas
app.get('/api/v1/mcp/get_conversation_analytics', async (req, res) => {
  try {
    const { user_id, date_range, metrics } = req.query;
    
    let query = supabase.from('conversations').select('*');
    
    if (user_id) {
      query = query.eq('user_id', user_id);
    }
    
    if (date_range) {
      const range = JSON.parse(date_range);
      query = query.gte('created_at', range.start).lte('created_at', range.end);
    }

    const { data: conversations, error } = await query;

    if (error) {
      logger.error('Error fetching analytics:', error);
      return res.status(500).json({ error: 'Failed to fetch analytics' });
    }

    const analytics = {
      total_conversations: conversations.length,
      unique_users: [...new Set(conversations.map(c => c.user_id))].length,
      avg_messages_per_conversation: conversations.reduce((acc, c) => acc + c.messages.length, 0) / conversations.length || 0,
      intent_distribution: getIntentDistribution(conversations),
      sentiment_analysis: getSentimentAnalysis(conversations),
      peak_hours: getPeakHours(conversations),
      completion_rate: getCompletionRate(conversations)
    };

    res.json(analytics);
  } catch (error) {
    logger.error('Error in get_conversation_analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ------------------------- Helper Functions -------------------------- */

function calculateAvgResponseTime(conversations) {
  // Implementar cálculo de tempo médio de resposta
  return 0;
}

function extractPreferredTopics(conversations) {
  // Extrair tópicos preferidos baseado nas conversas
  return [];
}

function calculateConversationDuration(messages) {
  if (messages.length < 2) return 0;
  const first = new Date(messages[0].timestamp);
  const last = new Date(messages[messages.length - 1].timestamp);
  return Math.round((last - first) / 1000); // duration in seconds
}

async function analyzeConversation(messages) {
  // Análise básica de sentimento e intenção
  const text = messages.map(m => m.content).join(' ');
  
  return {
    sentiment: analyzeSentiment(text),
    intent: detectIntent(text),
    topics: extractTopics(text),
    confidence: 0.8
  };
}

function analyzeSentiment(text) {
  // Implementação básica de análise de sentimento
  const positiveWords = ['bom', 'ótimo', 'excelente', 'obrigado', 'perfeito'];
  const negativeWords = ['ruim', 'péssimo', 'problema', 'erro', 'frustrado'];
  
  const words = text.toLowerCase().split(' ');
  const positive = words.filter(w => positiveWords.includes(w)).length;
  const negative = words.filter(w => negativeWords.includes(w)).length;
  
  if (positive > negative) return 'positive';
  if (negative > positive) return 'negative';
  return 'neutral';
}

function detectIntent(text) {
  // Detecção básica de intenção
  const intents = {
    'support': ['ajuda', 'problema', 'suporte', 'dúvida'],
    'purchase': ['comprar', 'preço', 'valor', 'produto'],
    'information': ['informação', 'saber', 'como', 'quando'],
    'complaint': ['reclamação', 'insatisfeito', 'problema', 'cancelar']
  };
  
  const words = text.toLowerCase().split(' ');
  
  for (const [intent, keywords] of Object.entries(intents)) {
    if (keywords.some(keyword => words.includes(keyword))) {
      return intent;
    }
  }
  
  return 'unknown';
}

function extractTopics(text) {
  // Extração básica de tópicos
  return ['general'];
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
  const completed = conversations.filter(c => c.metadata?.completion_status === 'completed').length;
  return conversations.length > 0 ? (completed / conversations.length) * 100 : 0;
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

/* --------------------------- Error Handlers -------------------------- */

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    message: 'The requested endpoint does not exist',
    path: req.originalUrl
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
      logger.info(`🛠️  MCP Tools: http://localhost:${PORT}/api/v1/mcp/tools`);
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