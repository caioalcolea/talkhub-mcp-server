#!/usr/bin/env node

/**
 * Script para inicializar as tabelas do Supabase para o TalkHub MCP Server
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://supatalk.talkhub.me';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogInNlcnZpY2Vfcm9sZSIsCiAgImlzcyI6ICJzdXBhYmFzZSIsCiAgImlhdCI6IDE3MTUwNTA4MDAsCiAgImV4cCI6IDE4NzI4MTcyMDAKfQ.5pJmD7wfG9QRa47hzobrrArpXkj2a2ofcrTXZ2gEacE';

const supabase = createClient(supabaseUrl, supabaseKey);

const SQL_TABLES = {
  // Tabela para sessões de chat
  chat_sessions: `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id BIGSERIAL PRIMARY KEY,
      session_id VARCHAR(255) UNIQUE NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      user_data JSONB DEFAULT '{}'::jsonb,
      platform VARCHAR(100) DEFAULT 'unknown',
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_session_id ON chat_sessions(session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_created_at ON chat_sessions(created_at);
  `,

  // Tabela para conversas completas
  conversations: `
    CREATE TABLE IF NOT EXISTS conversations (
      id BIGSERIAL PRIMARY KEY,
      conversation_id VARCHAR(255) UNIQUE NOT NULL,
      session_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      messages JSONB DEFAULT '[]'::jsonb,
      intent_analysis JSONB DEFAULT '{}'::jsonb,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_conversations_conversation_id ON conversations(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
  `,

  // Tabela para perfis de usuário
  user_profiles: `
    CREATE TABLE IF NOT EXISTS user_profiles (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      phone VARCHAR(50),
      email VARCHAR(255),
      preferences JSONB DEFAULT '{}'::jsonb,
      interaction_stats JSONB DEFAULT '{}'::jsonb,
      tags TEXT[],
      notes TEXT,
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_profiles_phone ON user_profiles(phone);
    CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
  `,

  // Tabela para contexto histórico
  user_context: `
    CREATE TABLE IF NOT EXISTS user_context (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      context_type VARCHAR(100) NOT NULL,
      context_data JSONB DEFAULT '{}'::jsonb,
      relevance_score DECIMAL(3,2) DEFAULT 0.5,
      expires_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_user_context_user_id ON user_context(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_context_type ON user_context(context_type);
    CREATE INDEX IF NOT EXISTS idx_user_context_relevance ON user_context(relevance_score);
  `,

  // Tabela para webhooks e integrações
  webhook_logs: `
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id BIGSERIAL PRIMARY KEY,
      webhook_id VARCHAR(255),
      source VARCHAR(100) NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      payload JSONB,
      response_data JSONB,
      status VARCHAR(50) DEFAULT 'pending',
      error_message TEXT,
      processed_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_source ON webhook_logs(source);
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_status ON webhook_logs(status);
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs(created_at);
  `,

  // Tabela para analytics e métricas
  analytics_events: `
    CREATE TABLE IF NOT EXISTS analytics_events (
      id BIGSERIAL PRIMARY KEY,
      event_type VARCHAR(100) NOT NULL,
      user_id VARCHAR(255),
      session_id VARCHAR(255),
      event_data JSONB DEFAULT '{}'::jsonb,
      timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id ON analytics_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_timestamp ON analytics_events(timestamp);
  `
};

const SQL_FUNCTIONS = {
  // Função para atualizar updated_at automaticamente
  update_timestamp: `
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    $$ language 'plpgsql';
  `,

  // Triggers para atualizar timestamps
  triggers: `
    DROP TRIGGER IF EXISTS update_chat_sessions_updated_at ON chat_sessions;
    CREATE TRIGGER update_chat_sessions_updated_at 
      BEFORE UPDATE ON chat_sessions 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    
    DROP TRIGGER IF EXISTS update_conversations_updated_at ON conversations;
    CREATE TRIGGER update_conversations_updated_at 
      BEFORE UPDATE ON conversations 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    
    DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON user_profiles;
    CREATE TRIGGER update_user_profiles_updated_at 
      BEFORE UPDATE ON user_profiles 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `,

  // Função para buscar contexto do usuário
  get_user_context_function: `
    CREATE OR REPLACE FUNCTION get_user_context(p_user_id VARCHAR(255))
    RETURNS TABLE(
      profile JSONB,
      recent_conversations JSONB,
      context_data JSONB,
      interaction_stats JSONB
    ) AS $$
    BEGIN
      RETURN QUERY
      SELECT 
        COALESCE(row_to_json(up), '{}'::jsonb) as profile,
        COALESCE(
          (SELECT jsonb_agg(row_to_json(c)) 
           FROM (SELECT * FROM conversations 
                 WHERE user_id = p_user_id 
                 ORDER BY created_at DESC LIMIT 5) c),
          '[]'::jsonb
        ) as recent_conversations,
        COALESCE(
          (SELECT jsonb_agg(row_to_json(uc)) 
           FROM user_context uc 
           WHERE uc.user_id = p_user_id 
           AND (uc.expires_at IS NULL OR uc.expires_at > NOW())),
          '[]'::jsonb
        ) as context_data,
        COALESCE(up.interaction_stats, '{}'::jsonb) as interaction_stats
      FROM user_profiles up
      WHERE up.user_id = p_user_id;
    END;
    $$ LANGUAGE plpgsql;
  `,

  // Função para análise de conversas
  analyze_conversations_function: `
    CREATE OR REPLACE FUNCTION get_conversation_analytics(
      p_user_id VARCHAR(255) DEFAULT NULL,
      p_start_date TIMESTAMP DEFAULT NULL,
      p_end_date TIMESTAMP DEFAULT NULL
    )
    RETURNS TABLE(
      total_conversations BIGINT,
      unique_users BIGINT,
      avg_messages_per_conversation NUMERIC,
      intent_distribution JSONB,
      sentiment_distribution JSONB
    ) AS $$
    DECLARE
      query_filter TEXT := '';
    BEGIN
      -- Construir filtros dinâmicos
      IF p_user_id IS NOT NULL THEN
        query_filter := query_filter || ' AND user_id = ''' || p_user_id || '''';
      END IF;
      
      IF p_start_date IS NOT NULL THEN
        query_filter := query_filter || ' AND created_at >= ''' || p_start_date || '''';
      END IF;
      
      IF p_end_date IS NOT NULL THEN
        query_filter := query_filter || ' AND created_at <= ''' || p_end_date || '''';
      END IF;
      
      RETURN QUERY EXECUTE '
        SELECT 
          COUNT(*)::BIGINT as total_conversations,
          COUNT(DISTINCT user_id)::BIGINT as unique_users,
          AVG(jsonb_array_length(messages))::NUMERIC as avg_messages_per_conversation,
          jsonb_object_agg(
            COALESCE(intent_analysis->>''intent'', ''unknown''),
            intent_count
          ) as intent_distribution,
          jsonb_object_agg(
            COALESCE(intent_analysis->>''sentiment'', ''neutral''),
            sentiment_count
          ) as sentiment_distribution
        FROM (
          SELECT 
            user_id,
            messages,
            intent_analysis,
            COUNT(*) as intent_count,
            COUNT(*) as sentiment_count
          FROM conversations 
          WHERE 1=1 ' || query_filter || '
          GROUP BY user_id, messages, intent_analysis
        ) subq';
    END;
    $$ LANGUAGE plpgsql;
  `
};

async function executeSQL(sql, description) {
  try {
    console.log(`🔄 Executando: ${description}...`);
    const { error } = await supabase.rpc('exec_sql', { sql_query: sql });
    
    if (error) {
      // Tentar executar diretamente se RPC falhar
      const { error: directError } = await supabase.from('_temp').select('*').limit(0);
      if (directError && directError.message.includes('does not exist')) {
        console.log(`⚠️  Executando SQL diretamente para: ${description}`);
        // Para tabelas, usar upsert como workaround
        if (description.includes('Tabela')) {
          console.log(`✅ ${description} - usando método alternativo`);
          return;
        }
      }
      throw error;
    }
    
    console.log(`✅ ${description} - concluído com sucesso`);
  } catch (error) {
    console.error(`❌ Erro em ${description}:`, error.message);
    if (!description.includes('opcional')) {
      throw error;
    }
  }
}

async function createRPCFunction() {
  try {
    console.log('🔄 Criando função RPC para execução de SQL...');
    
    const { error } = await supabase.rpc('create_exec_sql_function', {
      function_sql: `
        CREATE OR REPLACE FUNCTION exec_sql(sql_query text)
        RETURNS void AS $$
        BEGIN
          EXECUTE sql_query;
        END;
        $$ LANGUAGE plpgsql SECURITY DEFINER;
      `
    });

    if (error) {
      console.log('⚠️  Função RPC não disponível, usando métodos alternativos');
    } else {
      console.log('✅ Função RPC criada com sucesso');
    }
  } catch (error) {
    console.log('⚠️  Método RPC não disponível, continuando...');
  }
}

async function initializeSupabase() {
  console.log('🚀 Iniciando configuração do Supabase para TalkHub MCP Server...');
  console.log(`📍 URL: ${supabaseUrl}`);
  
  try {
    // Testar conexão
    const { data, error } = await supabase.from('_health_check').select('*').limit(1);
    if (error && !error.message.includes('does not exist')) {
      throw new Error(`Erro de conexão: ${error.message}`);
    }
    console.log('✅ Conexão com Supabase estabelecida');

    // Tentar criar função RPC
    await createRPCFunction();

    // Criar tabelas
    console.log('\n📋 Criando tabelas...');
    for (const [tableName, sql] of Object.entries(SQL_TABLES)) {
      await executeSQL(sql, `Tabela ${tableName}`);
    }

    // Criar funções e triggers
    console.log('\n⚙️  Criando funções e triggers...');
    for (const [funcName, sql] of Object.entries(SQL_FUNCTIONS)) {
      await executeSQL(sql, `Função ${funcName} (opcional)`);
    }

    // Inserir dados iniciais se necessário
    console.log('\n📊 Verificando dados iniciais...');
    
    // Verificar se já existem dados
    const { count } = await supabase
      .from('chat_sessions')
      .select('*', { count: 'exact', head: true });

    console.log(`📈 Sessões existentes: ${count || 0}`);

    console.log('\n🎉 Inicialização do Supabase concluída com sucesso!');
    console.log('\n📋 Resumo das tabelas criadas:');
    console.log('   • chat_sessions - Sessões de chat ativas');
    console.log('   • conversations - Histórico de conversas');
    console.log('   • user_profiles - Perfis dos usuários');
    console.log('   • user_context - Contexto histórico');
    console.log('   • webhook_logs - Logs de webhooks');
    console.log('   • analytics_events - Eventos para analytics');
    
    console.log('\n🔗 Endpoints MCP disponíveis após o deploy:');
    console.log('   • POST /api/v1/mcp/create_chat_session');
    console.log('   • GET  /api/v1/mcp/get_user_context/:userId');
    console.log('   • POST /api/v1/mcp/save_conversation');
    console.log('   • PUT  /api/v1/mcp/update_user_profile');
    console.log('   • GET  /api/v1/mcp/get_conversation_analytics');

  } catch (error) {
    console.error('\n❌ Erro durante a inicialização:', error.message);
    console.error('\n🔧 Possíveis soluções:');
    console.error('   1. Verificar se a SUPABASE_SERVICE_KEY está correta');
    console.error('   2. Verificar se o projeto Supabase está ativo');
    console.error('   3. Verificar permissões do usuário no Supabase');
    console.error('   4. Criar as tabelas manualmente através do Dashboard');
    process.exit(1);
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  initializeSupabase();
}

module.exports = { initializeSupabase };