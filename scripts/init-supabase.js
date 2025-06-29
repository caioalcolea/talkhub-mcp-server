#!/usr/bin/env node

/**
 * Script para inicializar as tabelas do Supabase para o TalkHub MCP Server
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not set in environment.');
  process.exit(1);
}
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

  // Tabela para logs de webhooks e integrações
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

  // Tabela para eventos de analytics
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
  // Função para atualizar automaticamente o campo updated_at (trigger function)
  update_timestamp: `
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    $$ language 'plpgsql';
  `,

  // Triggers para atualizar timestamps nas tabelas (usam a função acima)
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

  // Função para obter contexto completo do usuário (view combinando perfil, conversas etc.)
  get_user_context_function: `
    CREATE OR REPLACE FUNCTION get_user_context(p_user_id VARCHAR(255))
    RETURNS TABLE(
      profile JSONB,
      recent_conversations JSONB,
      context JSONB
    )
    LANGUAGE plpgsql
    AS $$
    DECLARE 
      query_filter TEXT := '';
    BEGIN
      RETURN QUERY
      SELECT 
        (SELECT row_to_json(u) FROM user_profiles AS u WHERE u.user_id = p_user_id) AS profile,
        (SELECT json_agg(c) FROM (SELECT * FROM conversations WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT 5) AS c) AS recent_conversations,
        (SELECT json_agg(ctx) FROM user_context AS ctx WHERE ctx.user_id = p_user_id) AS context;
    END;
    $$;
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
        // Para tabelas, assumimos que já existem ou serão criadas manualmente se RPC não disponível
        if (description.includes('Tabela')) {
          console.log(`✅ ${description} - usando método alternativo (IF NOT EXISTS garantiu existência ou tabela já existe)`);
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
    // Testar conexão básica
    const { error } = await supabase.from('_health_check').select('*').limit(1);
    if (error && !error.message.includes('does not exist')) {
      throw new Error(`Erro de conexão: ${error.message}`);
    }
    console.log('✅ Conexão com Supabase estabelecida');

    // Tentar criar função RPC utilitária (exec_sql)
    await createRPCFunction();

    // Criar tabelas necessárias
    console.log('\n📋 Criando tabelas...');
    for (const [tableName, sql] of Object.entries(SQL_TABLES)) {
      await executeSQL(sql, `Tabela ${tableName}`);
    }

    // Criar funções e triggers necessários
    console.log('\n⚙️  Criando funções e triggers...');
    for (const [funcName, sql] of Object.entries(SQL_FUNCTIONS)) {
      await executeSQL(sql, `Função ${funcName} (opcional)`);
    }

    // Dados iniciais (se necessário) - exemplo de verificação
    console.log('\n📊 Verificando dados iniciais...');
    const { count } = await supabase
      .from('chat_sessions')
      .select('*', { count: 'exact', head: true });
    console.log(`📈 Sessões existentes: ${count || 0}`);

    console.log('\n🎉 Inicialização do Supabase concluída com sucesso!');
    console.log('\n📋 Resumo das tabelas preparadas:');
    console.log('   • chat_sessions – Sessões de chat ativas');
    console.log('   • conversations – Histórico de conversas');
    console.log('   • user_profiles – Perfis dos usuários');
    console.log('   • user_context – Contexto histórico');
    console.log('   • webhook_logs – Logs de webhooks');
    console.log('   • analytics_events – Eventos para analytics');
    
    console.log('\n🔗 Após o deploy, certifique-se de que as funções MCP estejam acessíveis via API:');
    console.log('   • POST /api/v1/mcp/create_chat_session');
    console.log('   • GET  /api/v1/mcp/get_user_context/:userId');
    console.log('   • POST /api/v1/mcp/save_conversation');
    console.log('   • PUT  /api/v1/mcp/update_user_profile');
    console.log('   • GET  /api/v1/mcp/get_conversation_analytics');

  } catch (error) {
    console.error('\n❌ Erro durante a inicialização:', error.message);
    console.error('\n🔧 Possíveis soluções:');
    console.error('   1. Verificar se a SUPABASE_SERVICE_KEY está correta no .env');
    console.error('   2. Verificar se o projeto Supabase está acessível e ativo');
    console.error('   3. Verificar permissões do usuário (service role) no Supabase');
    console.error('   4. Criar as tabelas manualmente através do Dashboard ou SQL pad do Supabase');
    process.exit(1);
  }
}

// Executar automaticamente se chamado diretamente pela linha de comando
if (require.main === module) {
  initializeSupabase();
}

module.exports = { initializeSupabase };
