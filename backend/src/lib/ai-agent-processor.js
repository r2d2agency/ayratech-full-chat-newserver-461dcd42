/**
 * AI Agent Processor for Real WhatsApp Chat
 * 
 * Handles incoming messages through AI agents:
 * 1. Checks if conversation has an active agent session
 * 2. If not, checks if connection has a linked agent (via ai_agent_connections)
 * 3. Validates mode (always, business_hours, keywords)
 * 4. Creates/continues session, processes with tools, sends response
 * 5. Handles handoff keywords and failure counting
 */

import { query } from '../db.js';
import { callAI, callAIWithTools } from './ai-caller.js';
import { logInfo, logError } from '../logger.js';
import { searchKnowledge } from './knowledge-processor.js';
import * as whatsappProvider from './whatsapp-provider.js';

// ==================== MESSAGE BATCHING ====================
// Collects multiple messages from same contact within a window before processing

const MESSAGE_BATCH_DELAY_MS = 5000; // Wait 5 seconds to collect messages
const pendingBatches = new Map(); // conversationId -> { messages[], timer, params }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function hasTables(tableNames) {
  const placeholders = tableNames.map((_, index) => `$${index + 1}`).join(', ');
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN (${placeholders})`,
    tableNames
  );
  return Number(result.rows[0]?.count || 0) === tableNames.length;
}

// ==================== MAIN ENTRY POINT ====================

/**
 * Process an incoming message through AI agent if applicable
 * @param {Object} params
 * @param {Object} params.connection - The WhatsApp connection object
 * @param {string} params.conversationId - Conversation UUID
 * @param {string} params.contactPhone - Contact phone number
 * @param {string} params.contactName - Contact display name
 * @param {string} params.messageContent - Text content of the message
 * @param {string} params.messageType - 'text', 'image', 'audio', etc.
 * @returns {Object} { handled: boolean, agentId?: string, response?: string }
 */
export async function processIncomingWithAgent({
  connection,
  conversationId,
  contactPhone,
  contactName,
  messageContent,
  messageType,
  mediaUrl,
  mediaMimetype,
  mediaFilename,
}) {
  // For text messages, batch multiple messages within a window
  if (messageType === 'text' && messageContent) {
    return new Promise((resolve) => {
      const existing = pendingBatches.get(conversationId);
      
      if (existing) {
        // Add message to existing batch
        existing.messages.push(messageContent);
        clearTimeout(existing.timer);
        existing.timer = setTimeout(async () => {
          pendingBatches.delete(conversationId);
          const mergedContent = existing.messages.join('\n');
          const result = await processMessageInternal({
            connection, conversationId, contactPhone, contactName,
            messageContent: mergedContent, messageType: 'text',
            mediaUrl: null, mediaMimetype: null, mediaFilename: null,
          });
          // Resolve all pending promises
          existing.resolvers.forEach(r => r(result));
          resolve(result);
        }, MESSAGE_BATCH_DELAY_MS);
        existing.resolvers.push(resolve);
      } else {
        // Start new batch
        const batch = {
          messages: [messageContent],
          resolvers: [resolve],
          timer: setTimeout(async () => {
            pendingBatches.delete(conversationId);
            const mergedContent = batch.messages.join('\n');
            const result = await processMessageInternal({
              connection, conversationId, contactPhone, contactName,
              messageContent: mergedContent, messageType: 'text',
              mediaUrl: null, mediaMimetype: null, mediaFilename: null,
            });
            batch.resolvers.forEach(r => r(result));
          }, MESSAGE_BATCH_DELAY_MS),
        };
        pendingBatches.set(conversationId, batch);
      }
    });
  }

  // Non-text messages are processed immediately
  return processMessageInternal({
    connection, conversationId, contactPhone, contactName,
    messageContent, messageType, mediaUrl, mediaMimetype, mediaFilename,
  });
}

async function processMessageInternal({
  connection, conversationId, contactPhone, contactName,
  messageContent, messageType, mediaUrl, mediaMimetype, mediaFilename,
}) {
  try {
    // Supported message types
    const supportedTypes = ['text', 'image', 'audio', 'video', 'document', 'sticker'];
    if (!supportedTypes.includes(messageType)) {
      return { handled: false };
    }
    // Need at least content or media
    if (!messageContent && !mediaUrl && messageType === 'text') {
      return { handled: false };
    }

    const organizationId = connection.organization_id;
    if (!organizationId) return { handled: false };

    // 1. Check for active session first
    let session = await getActiveSession(conversationId);

    // 1.1 If session exists but is paused or human-taken-over, skip AI processing
    if (session) {
      if (session.human_takeover) {
        logInfo('ai_agent_processor.human_takeover_active', { conversationId });
        return { handled: false, reason: 'human_takeover' };
      }
      if (session.paused_until && new Date(session.paused_until) > new Date()) {
        logInfo('ai_agent_processor.session_paused', { conversationId, paused_until: session.paused_until });
        return { handled: false, reason: 'paused' };
      }
      // If paused_until has expired, clear it
      if (session.paused_until && new Date(session.paused_until) <= new Date()) {
        await query(`UPDATE ai_agent_sessions SET paused_until = NULL WHERE id = $1`, [session.id]);
      }
    }

    // 2. If no active session, check if an agent is linked to this connection
    if (!session) {
      let agent = await findAgentForConnection(connection.id, messageContent);
      
      // 2.1 If no regular agent, check for global agent activations
      if (!agent) {
        agent = await findGlobalAgentForConnection(connection.id);
      }
      
      if (!agent) return { handled: false };

      // Create a new session
      session = await createSession(agent.id, conversationId, contactPhone, contactName);
      session._isNewSession = true;
      session._isGlobalAgent = !!agent._isGlobalAgent;
      logInfo('ai_agent_processor.session_created', {
        sessionId: session.id,
        agentId: agent.id,
        conversationId,
        contactPhone,
        isGlobal: !!agent._isGlobalAgent,
      });

      // Send greeting message if configured and it's a brand new session
      if (agent.greeting_message) {
        await sendAgentMessage(connection, contactPhone, agent.greeting_message, session.id);
        // Save greeting as agent message
        await saveAgentMessage(session.id, 'assistant', agent.greeting_message, 0);
      }
    }

    // 3. Load the agent
    const agentResult = await query(
      `SELECT * FROM ai_agents WHERE id = $1 AND is_active = true`,
      [session.agent_id]
    );

    if (agentResult.rows.length === 0) {
      // Agent was deactivated, end session
      await endSession(session.id, 'agent_deactivated');
      return { handled: false };
    }

    const agent = agentResult.rows[0];

    // 4. Check handoff keywords (only for text messages)
    const handoffKeywords = parseArray(agent.handoff_keywords, ['humano', 'atendente', 'pessoa']);
    if (messageContent && messageType === 'text') {
      const lowerContent = messageContent.toLowerCase();
      const handoffTriggered = handoffKeywords.some(kw => lowerContent.includes(kw.toLowerCase()));

      if (handoffTriggered) {
        // Check required variables before handoff
        const requiredVars = parseRequiredVariables(agent.required_variables);
        if (requiredVars.length > 0) {
          const session_vars = session.context_variables || {};
          const missing = requiredVars.filter(v => !session_vars[v.name]);
          if (missing.length > 0) {
            // Don't handoff yet - let AI ask for missing variables
            logInfo('ai_agent_processor.handoff_blocked_missing_vars', {
              conversationId, missing: missing.map(v => v.name),
            });
            // Continue to AI processing - the prompt will instruct to collect variables
          } else {
            await handleHandoff(session, agent, connection, contactPhone);
            return { handled: true, agentId: agent.id, response: agent.handoff_message };
          }
        } else {
          await handleHandoff(session, agent, connection, contactPhone);
          return { handled: true, agentId: agent.id, response: agent.handoff_message };
        }
      }
    }

    // 5. Load AI config EARLY (needed for transcription and later for AI call)
    const aiConfig = await getAgentAIConfig(agent, organizationId);

    // 6. Process media content - build a user message with context
    const capabilities = parseArray(agent.capabilities, ['respond_messages']);
    // Backward compatibility: before capability split, media handling was bundled under read_files
    const canTranscribe = capabilities.includes('transcribe_audio') || capabilities.includes('read_files');
    const canAnalyzeImages = capabilities.includes('analyze_images') || capabilities.includes('read_files');

    let userMessageForHistory = messageContent || '';
    let userMessageForAI = null; // Will be a string or multimodal content array

    if (messageType === 'audio') {
      if (!canTranscribe) {
        logInfo('ai_agent_processor.audio_capability_missing', {
          sessionId: session.id,
          agentId: agent.id,
          capabilities,
        });
        userMessageForHistory = messageContent || '[Mensagem de áudio recebida]';
        userMessageForAI = messageContent || '[O cliente enviou uma mensagem de áudio. Você não tem a capacidade de ouvir áudios. Peça educadamente para o cliente enviar a mensagem como texto.]';
      } else if (mediaUrl) {
        // Transcribe audio using the agent's own AI config
        try {
          const transcript = await transcribeAudio(mediaUrl, mediaMimetype, aiConfig);
          if (transcript && transcript !== '[Áudio inaudível]') {
            userMessageForHistory = `[Áudio transcrito]: ${transcript}`;
            userMessageForAI = transcript;
          } else {
            userMessageForHistory = messageContent || '[Mensagem de áudio recebida]';
            userMessageForAI = messageContent || '[O cliente enviou uma mensagem de áudio. Informe que você recebeu o áudio e peça para enviar como texto se possível.]';
          }
        } catch (err) {
          logError('ai_agent_processor.transcribe_catch', err);
          userMessageForHistory = messageContent || '[Mensagem de áudio recebida]';
          userMessageForAI = messageContent || '[O cliente enviou uma mensagem de áudio que não pôde ser processada. Informe que recebeu e peça para enviar como texto.]';
        }
      } else {
        // Audio without URL (encrypted/failed cache)
        userMessageForHistory = messageContent || '[Mensagem de áudio recebida]';
        userMessageForAI = messageContent || '[O cliente enviou uma mensagem de áudio mas não foi possível acessar o arquivo. Informe que recebeu e peça para enviar como texto.]';
      }
    } else if (messageType === 'image' && mediaUrl) {
      if (!canAnalyzeImages) {
        logInfo('ai_agent_processor.image_capability_missing', { sessionId: session.id, agentId: agent.id, capabilities });
        userMessageForHistory = messageContent || '[Imagem recebida]';
        userMessageForAI = messageContent || '[O cliente enviou uma imagem, mas você não possui a capacidade de analisar imagens. Peça para descrever em texto o conteúdo da imagem.]';
      } else {
        const caption = messageContent || '';
        userMessageForHistory = caption ? `[Imagem com legenda]: ${caption}` : '[Imagem recebida]';
        // Build multimodal message for AI
        userMessageForAI = buildImageMessage(mediaUrl, caption);
      }
    } else if (messageType === 'video' && mediaUrl) {
      const caption = messageContent || '';
      userMessageForHistory = caption ? `[Vídeo com legenda]: ${caption}` : '[Vídeo recebido]';
      userMessageForAI = caption || '[O cliente enviou um vídeo. Responda reconhecendo o recebimento do vídeo.]';
    } else if (messageType === 'document' && mediaUrl) {
      const filename = mediaFilename || 'documento';
      userMessageForHistory = messageContent 
        ? `[Documento: ${filename}]: ${messageContent}` 
        : `[Documento recebido: ${filename}]`;
      userMessageForAI = await buildDocumentMessage(mediaUrl, filename, messageContent, mediaMimetype);
    } else if (messageType === 'sticker') {
      userMessageForHistory = '[Sticker recebido]';
      userMessageForAI = '[O cliente enviou um sticker/figurinha. Responda de forma leve e amigável.]';
    } else if (messageType === 'image' && !mediaUrl) {
      userMessageForHistory = messageContent || '[Imagem recebida sem URL]';
      userMessageForAI = messageContent || '[O cliente enviou uma imagem mas não foi possível visualizá-la. Confirme o recebimento.]';
    } else if (messageType === 'document' && !mediaUrl) {
      userMessageForHistory = messageContent || '[Documento recebido sem URL]';
      userMessageForAI = messageContent || '[O cliente enviou um documento mas não foi possível acessá-lo. Confirme o recebimento.]';
    } else {
      userMessageForAI = messageContent;
    }

    // Ensure we always have something to send to the AI
    if (!userMessageForAI && !messageContent) {
      userMessageForAI = `[O cliente enviou uma mensagem do tipo "${messageType}". Confirme o recebimento e pergunte como pode ajudar.]`;
      userMessageForHistory = userMessageForHistory || `[${messageType} recebido]`;
    }

    // 6b. Save user message to history
    await saveAgentMessage(session.id, 'user', userMessageForHistory, 0);

    // 7. Build conversation history from session
    const history = await getSessionHistory(session.id, agent.context_window || 10);

    // 8. Build system prompt with RAG knowledge base
    const systemPrompt = await buildSystemPrompt(agent, organizationId, contactName, userMessageForAI || userMessageForHistory, aiConfig);

    // 8. Build messages array
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];

    // Add current user message (might be multimodal for images)
    if (Array.isArray(userMessageForAI)) {
      messages.push({ role: 'user', content: userMessageForAI });
    } else {
      messages.push({ role: 'user', content: userMessageForAI || userMessageForHistory });
    }

    // 9. Build tools based on capabilities
    const tools = await buildToolsForAgent(agent, capabilities, organizationId);

    // 10. Get AI config (already loaded above)
    // const aiConfig = await getAgentAIConfig(agent, organizationId);  // reuse from above

    // 11. Call AI
    let result;
    let toolCallsExecuted = [];
    const startTime = Date.now();

    const userId = agent.default_user_id || agent.created_by;

    if (tools.length > 0) {
      const toolExecutor = createToolExecutor(organizationId, userId);
      result = await callAIWithTools(aiConfig, messages, {
        temperature: parseFloat(agent.temperature) || 0.7,
        maxTokens: parseInt(agent.max_tokens, 10) || 1000,
        tools,
      }, toolExecutor);
      toolCallsExecuted = result.toolCallsExecuted || [];
    } else {
      result = await callAI(aiConfig, messages, {
        temperature: parseFloat(agent.temperature) || 0.7,
        maxTokens: parseInt(agent.max_tokens, 10) || 1000,
      });
    }

    const responseTime = Date.now() - startTime;
    const responseText = result.content || agent.fallback_message || 'Desculpe, não consegui processar sua mensagem.';

    // 12. Save assistant message
    await saveAgentMessage(session.id, 'assistant', responseText, result.tokensUsed || 0, toolCallsExecuted);

    // 13. Send typing indicator + human-like delay, then send response
    try {
      await whatsappProvider.sendPresenceComposing(connection, contactPhone);
      // Human-like delay: 1-3 seconds based on response length
      const typingDelay = Math.min(3000, Math.max(1000, responseText.length * 15));
      await sleep(typingDelay);
    } catch (e) {
      // Non-critical
    }
    await sendAgentMessage(connection, contactPhone, responseText, session.id);

    // 14. Notify external number if enabled (only on first message of session)
    if (agent.notify_external_enabled && agent.notify_external_phone && session._isNewSession) {
      const summary = agent.notify_external_summary !== false
        ? `📋 *Resumo do Atendimento IA*\n\n👤 *Cliente:* ${contactName || contactPhone}\n📱 *Telefone:* ${contactPhone}\n🤖 *Agente:* ${agent.name}\n\n💬 *Solicitação:* ${typeof userMessageForAI === 'string' ? userMessageForAI : messageContent}\n\n📝 *Resposta do Agente:* ${responseText.substring(0, 500)}`
        : `🔔 *Nova interação*\n\n👤 ${contactName || contactPhone} enviou mensagem para o agente *${agent.name}*.`;
      
      sendAgentMessage(connection, agent.notify_external_phone, summary, session.id)
        .catch(err => logError('ai_agent_processor.external_notify_error', err));
    }

    // 15. Update session stats
    await updateSessionStats(session.id, result.tokensUsed || 0, responseTime);

    // 16. Update agent stats
    await updateAgentStats(agent.id, result.tokensUsed || 0, responseTime, toolCallsExecuted);

    // 16. Check failure count (if response was fallback)
    if (!result.content && agent.auto_handoff_after_failures > 0) {
      const failCount = await incrementFailureCount(session.id);
      if (failCount >= agent.auto_handoff_after_failures) {
        await handleHandoff(session, agent, connection, contactPhone, 'auto_failure_limit');
      }
    }

    logInfo('ai_agent_processor.message_processed', {
      sessionId: session.id,
      agentId: agent.id,
      tokensUsed: result.tokensUsed,
      toolCalls: toolCallsExecuted.length,
      responseTimeMs: responseTime,
    });

    return {
      handled: true,
      agentId: agent.id,
      response: responseText,
    };
  } catch (error) {
    logError('ai_agent_processor.process_error', error);
    return { handled: false, error: error.message };
  }
}

// ==================== SESSION MANAGEMENT ====================

async function getActiveSession(conversationId) {
  const result = await query(
    `SELECT * FROM ai_agent_sessions 
     WHERE conversation_id = $1 AND is_active = true 
     ORDER BY started_at DESC LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] || null;
}

async function createSession(agentId, conversationId, contactPhone, contactName) {
  const result = await query(
    `INSERT INTO ai_agent_sessions (agent_id, conversation_id, contact_phone, contact_name)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [agentId, conversationId, contactPhone, contactName]
  );
  return result.rows[0];
}

async function endSession(sessionId, reason) {
  await query(
    `UPDATE ai_agent_sessions 
     SET is_active = false, ended_at = NOW(), handoff_reason = COALESCE(handoff_reason, $2)
     WHERE id = $1`,
    [sessionId, reason]
  );
}

async function updateSessionStats(sessionId, tokensUsed, responseTimeMs) {
  await query(
    `UPDATE ai_agent_sessions 
     SET message_count = message_count + 2, 
         last_interaction_at = NOW()
     WHERE id = $1`,
    [sessionId]
  );
}

async function incrementFailureCount(sessionId) {
  const result = await query(
    `UPDATE ai_agent_sessions 
     SET failure_count = failure_count + 1 
     WHERE id = $1 RETURNING failure_count`,
    [sessionId]
  );
  return result.rows[0]?.failure_count || 0;
}

// ==================== AGENT MESSAGE HISTORY ====================

async function saveAgentMessage(sessionId, role, content, totalTokens, toolCalls) {
  await query(
    `INSERT INTO ai_agent_messages (session_id, role, content, total_tokens, tool_calls)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, role, content, totalTokens || 0, toolCalls ? JSON.stringify(toolCalls) : null]
  );
}

async function getSessionHistory(sessionId, contextWindow) {
  const result = await query(
    `SELECT role, content FROM ai_agent_messages 
     WHERE session_id = $1 AND role IN ('user', 'assistant')
     ORDER BY created_at DESC 
     LIMIT $2`,
    [sessionId, contextWindow]
  );
  // Reverse to get chronological order
  return result.rows.reverse();
}

// ==================== AGENT RESOLUTION ====================

/**
 * Find the appropriate agent for a connection, checking mode and schedule
 */
async function findAgentForConnection(connectionId, messageContent) {
  const result = await query(
    `SELECT a.*, ac.mode, ac.trigger_keywords, 
            ac.business_hours_start, ac.business_hours_end, ac.business_days
     FROM ai_agent_connections ac
     JOIN ai_agents a ON a.id = ac.agent_id
     WHERE ac.connection_id = $1 AND ac.is_active = true AND a.is_active = true
     ORDER BY ac.priority DESC
     LIMIT 5`,
    [connectionId]
  );

  for (const agent of result.rows) {
    if (shouldActivateAgent(agent, messageContent)) {
      return agent;
    }
  }

  return null;
}

function shouldActivateAgent(agentConn, messageContent) {
  const { mode, trigger_keywords, business_hours_start, business_hours_end, business_days } = agentConn;

  if (mode === 'always') return true;

  if (mode === 'business_hours') {
    return isWithinBusinessHours(business_hours_start, business_hours_end, business_days);
  }

  if (mode === 'keywords') {
    const keywords = parseArray(trigger_keywords, []);
    if (keywords.length === 0) return false;
    const lower = (messageContent || '').toLowerCase();
    return keywords.some(kw => lower.includes(kw.toLowerCase()));
  }

  return false;
}

function isWithinBusinessHours(startTime, endTime, businessDays) {
  const now = new Date();
  const dayOfWeek = now.getDay();

  const days = parseArray(businessDays, [1, 2, 3, 4, 5]);
  if (!days.includes(dayOfWeek)) return false;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = (startTime || '08:00').split(':').map(Number);
  const [endH, endM] = (endTime || '18:00').split(':').map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;

  return currentMinutes >= start && currentMinutes < end;
}

// ==================== GLOBAL AGENT RESOLUTION ====================

/**
 * Find a global agent activation for a connection, checking schedule windows
 */
async function findGlobalAgentForConnection(connectionId) {
  try {
    const result = await query(
      `SELECT ga.*, act.schedule_mode, act.schedule_windows, 
              act.custom_field_values, act.prompt_additions, act.client_ai_api_key
       FROM global_agent_activations act
       JOIN global_ai_agents ga ON ga.id = act.global_agent_id AND ga.is_active = true
       WHERE act.connection_id = $1 AND act.is_active = true
       ORDER BY act.created_at ASC
       LIMIT 5`,
      [connectionId]
    );

    for (const agent of result.rows) {
      if (isGlobalAgentActive(agent)) {
        // Build a virtual agent object compatible with the existing flow
        let systemPrompt = agent.system_prompt || '';
        
        // Inject custom field values (replace {{key}} placeholders)
        const fieldValues = agent.custom_field_values || {};
        for (const [key, value] of Object.entries(fieldValues)) {
          if (value && !key.startsWith('_')) {
            systemPrompt = systemPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
          }
        }

        // Inject current date/time variables
        const now = new Date();
        const daysOfWeek = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
        const currentDay = daysOfWeek[now.getDay()];
        const currentTime = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
        const currentDate = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        
        systemPrompt = systemPrompt
          .replace(/\{\{current_day\}\}/gi, currentDay)
          .replace(/\{\{current_time\}\}/gi, currentTime)
          .replace(/\{\{current_date\}\}/gi, currentDate)
          .replace(/\{\{dia_atual\}\}/gi, currentDay)
          .replace(/\{\{hora_atual\}\}/gi, currentTime)
          .replace(/\{\{data_atual\}\}/gi, currentDate);

        // Build personalization from client settings
        const customName = fieldValues._custom_name;
        const voiceTone = fieldValues._voice_tone;
        const voiceGender = fieldValues._voice_gender;
        const personalizationParts = [];

        if (customName) {
          personalizationParts.push(`Seu nome é "${customName}". Sempre se apresente com esse nome.`);
        }
        if (voiceTone && voiceTone !== 'professional') {
          const toneLabels = { friendly: 'amigável', casual: 'casual', formal: 'formal', enthusiastic: 'entusiástico', empathetic: 'empático' };
          personalizationParts.push(`Use um tom de voz ${toneLabels[voiceTone] || voiceTone}.`);
        }
        if (voiceGender === 'male') {
          personalizationParts.push('Você é um assistente masculino. Use linguagem no gênero masculino.');
        } else if (voiceGender === 'female') {
          personalizationParts.push('Você é uma assistente feminina. Use linguagem no gênero feminino.');
        }

        if (personalizationParts.length > 0) {
          systemPrompt = personalizationParts.join(' ') + '\n\n' + systemPrompt;
        }

        // Build schedule/business hours context
        let scheduleInfo = '';
        const { schedule_mode, schedule_windows } = agent;
        if (schedule_mode === 'scheduled' && Array.isArray(schedule_windows) && schedule_windows.length > 0) {
          const dayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
          const windowDescriptions = schedule_windows.map(w => {
            const days = (w.days || []).map(d => dayNames[d] || d).join(', ');
            return `  • ${days}: ${w.start || '00:00'} às ${w.end || '23:59'}`;
          });
          scheduleInfo = `\n- Horário de funcionamento/atendimento:\n${windowDescriptions.join('\n')}`;
        } else if (schedule_mode === 'always') {
          scheduleInfo = '\n- Horário de funcionamento: Atendimento 24 horas';
        }

        // Always inject context about current date/time and schedule
        systemPrompt += `\n\nInformações de contexto:\n- Data atual: ${currentDate} (${currentDay})\n- Hora atual: ${currentTime} (horário de Brasília)${scheduleInfo}`;

        // Add prompt additions
        if (agent.prompt_additions) {
          systemPrompt += '\n\n' + agent.prompt_additions;
        }

        // Load knowledge base content if enabled
        if (agent.has_knowledge_base) {
          try {
            const kbResult = await query(`
              SELECT source_content, name FROM global_agent_knowledge_sources 
              WHERE global_agent_id = $1 AND status = 'completed' AND is_active = true
              ORDER BY created_at DESC LIMIT 5
            `, [agent.id]);
            if (kbResult.rows.length > 0) {
              systemPrompt += '\n\n=== BASE DE CONHECIMENTO ===\n';
              for (const src of kbResult.rows) {
                systemPrompt += `\n--- ${src.name} ---\n${src.source_content.substring(0, 3000)}\n`;
              }
            }
          } catch (e) {
            console.error('Error loading global agent knowledge:', e);
          }
        }

        agent.system_prompt = systemPrompt;
        agent._isGlobalAgent = true;
        
        // Use client API key if provided, otherwise fall back to agent key
        if (agent.client_ai_api_key) {
          agent.ai_api_key = agent.client_ai_api_key;
        }
        
        return agent;
      }
    }
  } catch (err) {
    // Table may not exist yet
    if (!String(err).includes('does not exist')) {
      logError('ai_agent_processor.global_agent_lookup_error', err);
    }
  }

  return null;
}

function isGlobalAgentActive(agent) {
  const { schedule_mode, schedule_windows } = agent;

  if (schedule_mode === 'always') return true;
  if (schedule_mode === 'manual') return true; // manual = controlled by is_active flag only

  if (schedule_mode === 'scheduled') {
    const windows = Array.isArray(schedule_windows) ? schedule_windows : [];
    if (windows.length === 0) return false;

    const now = new Date();
    const dayOfWeek = now.getDay();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    for (const window of windows) {
      const days = Array.isArray(window.days) ? window.days : [];
      if (!days.includes(dayOfWeek)) continue;

      const [startH, startM] = (window.start || '00:00').split(':').map(Number);
      const [endH, endM] = (window.end || '23:59').split(':').map(Number);
      const start = startH * 60 + (startM || 0);
      const end = endH * 60 + (endM || 0);

      // Handle overnight windows (e.g., 22:00 - 07:00)
      if (start <= end) {
        if (currentMinutes >= start && currentMinutes < end) return true;
      } else {
        // Crosses midnight
        if (currentMinutes >= start || currentMinutes < end) return true;
      }
    }

    return false;
  }

  return false;
}

// ==================== HANDOFF ====================


async function handleHandoff(session, agent, connection, contactPhone, reason) {
  // End the session
  await query(
    `UPDATE ai_agent_sessions 
     SET is_active = false, handoff_requested = true, handoff_at = NOW(), 
         handoff_reason = $2, ended_at = NOW()
     WHERE id = $1`,
    [session.id, reason || 'keyword_trigger']
  );

  // Send handoff message
  const handoffMsg = agent.handoff_message || 'Vou transferir você para um atendente humano. Aguarde um momento.';
  await sendAgentMessage(connection, contactPhone, handoffMsg, session.id);

  // Transfer to department/user if configured
  if (agent.default_department_id || agent.default_user_id) {
    const updates = [];
    const params = [];
    let idx = 1;

    if (agent.default_department_id) {
      updates.push(`department_id = $${idx++}`);
      params.push(agent.default_department_id);
    }
    if (agent.default_user_id) {
      updates.push(`assigned_to = $${idx++}`);
      params.push(agent.default_user_id);
    }
    updates.push(`attendance_status = 'waiting'`);

    params.push(session.conversation_id);
    await query(
      `UPDATE conversations SET ${updates.join(', ')} WHERE id = $${idx}`,
      params
    ).catch(err => logError('ai_agent_processor.handoff_assign_error', err));
  }

  logInfo('ai_agent_processor.handoff', {
    sessionId: session.id,
    agentId: agent.id,
    reason,
  });
}

// ==================== SEND MESSAGE ====================

async function sendAgentMessage(connection, contactPhone, text, sessionId, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await whatsappProvider.sendMessage(connection, contactPhone, text, 'text', null);

      if (result.success) {
        // Save outgoing message to chat_messages so it appears in the chat
        const conversationResult = await query(
          `SELECT id FROM conversations WHERE connection_id = $1 AND contact_phone = $2 LIMIT 1`,
          [connection.id, contactPhone]
        );
        
        if (conversationResult.rows[0]) {
          await query(
            `INSERT INTO chat_messages (conversation_id, message_id, content, message_type, from_me, status, timestamp)
             VALUES ($1, $2, $3, 'text', true, 'sent', NOW())`,
            [conversationResult.rows[0].id, result.messageId || `ai-agent-${Date.now()}`, text]
          );
        }
        return result;
      }

      lastError = result.error || 'Send failed';
      
      // Only retry on network-level errors, not API rejections
      if (result.error && (result.error.includes('fetch failed') || result.error.includes('ECONNREFUSED') || result.error.includes('ETIMEDOUT'))) {
        logInfo('ai_agent_processor.send_retry', { attempt, maxRetries, error: result.error });
        await sleep(attempt * 2000); // 2s, 4s, 6s backoff
        continue;
      }
      
      // Non-retryable error
      logError('ai_agent_processor.send_failed', new Error(lastError));
      return result;
    } catch (error) {
      lastError = error.message;
      if (attempt < maxRetries && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED'))) {
        logInfo('ai_agent_processor.send_retry_exception', { attempt, maxRetries, error: error.message });
        await sleep(attempt * 2000);
        continue;
      }
      logError('ai_agent_processor.send_error', error);
      return { success: false, error: error.message };
    }
  }

  logError('ai_agent_processor.send_exhausted', new Error(lastError || 'Max retries reached'));
  return { success: false, error: lastError || 'Max retries reached' };
}

// ==================== SYSTEM PROMPT ====================

async function buildSystemPrompt(agent, organizationId, contactName, userMessage, aiConfig) {
  let prompt = agent.system_prompt || 'Você é um assistente virtual profissional e prestativo.';

  // Include agent description as additional context/instructions
  if (agent.description && agent.description.trim()) {
    prompt += `\n\n${agent.description.trim()}`;
  }

  // Add personality traits
  const traits = parseArray(agent.personality_traits, []);
  if (traits.length > 0) {
    prompt += `\n\nTraços de personalidade: ${traits.join(', ')}`;
  }

  // RAG: Search knowledge base using semantic similarity
  if (userMessage && aiConfig?.apiKey) {
    try {
      const ragResults = await searchKnowledge(agent.id, 
        typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage), 
        { provider: aiConfig.provider, apiKey: aiConfig.apiKey }, 
        5
      );

      logInfo('ai_agent_processor.rag_results', {
        agentId: agent.id,
        resultsCount: ragResults.length,
      });

      if (ragResults.length > 0) {
        const knowledgeContext = ragResults
          .map((r, i) => {
            const label = r.metadata?.name ? ` (Fonte: ${r.metadata.name})` : '';
            const sim = r.metadata?.fallback ? '' : ` [relevância: ${(r.similarity * 100).toFixed(0)}%]`;
            return `--- Trecho ${i + 1}${label}${sim} ---\n${r.content}`;
          })
          .join('\n\n');

        prompt += `\n\nBase de Conhecimento (use estas informações para responder quando relevante):\n${knowledgeContext}`;
      }
    } catch (err) {
      logError('ai_agent_processor.rag_search_error', err);
      // Fallback to old behavior
      const knowledgeResult = await query(
        `SELECT source_content FROM ai_knowledge_sources WHERE agent_id = $1 AND is_active = true ORDER BY priority DESC LIMIT 3`,
        [agent.id]
      );
      if (knowledgeResult.rows.length > 0) {
        const knowledgeContext = knowledgeResult.rows.map(k => k.source_content.substring(0, 2000)).join('\n\n');
        prompt += `\n\nBase de Conhecimento:\n${knowledgeContext}`;
      }
    }
  } else {
    // No AI config for embeddings - use raw content (original behavior)
    const knowledgeResult = await query(
      `SELECT source_content, extracted_text FROM ai_knowledge_sources WHERE agent_id = $1 AND is_active = true ORDER BY priority DESC`,
      [agent.id]
    );
    if (knowledgeResult.rows.length > 0) {
      const knowledgeContext = knowledgeResult.rows.map(k => (k.extracted_text || k.source_content || '').substring(0, 2000)).join('\n\n');
      prompt += `\n\nBase de Conhecimento:\n${knowledgeContext}`;
    }
  }

  // Add context about the contact
  if (contactName) {
    prompt += `\n\nVocê está conversando com: ${contactName}`;
  }

  // Add language instruction
  prompt += `\n\nResponda sempre em ${agent.language || 'pt-BR'}.`;

  // Add human-like WhatsApp communication style
  prompt += `\n\nIMPORTANTE - Estilo de comunicação:
- Você está conversando via WhatsApp. Seja natural e humano.
- Use respostas CURTAS e diretas (1-3 frases por mensagem, como uma pessoa real).
- Faça perguntas curtas e objetivas, uma de cada vez.
- Use linguagem informal e conversacional (mas profissional).
- Evite textos longos, listas extensas ou parágrafos grandes.
- Não repita informações que já foram ditas.
- Responda como se fosse uma pessoa digitando no celular.
- Use emojis com moderação (1-2 por mensagem no máximo).
- Quando o cliente enviar várias mensagens seguidas, entenda o contexto completo antes de responder.`;

  // Add handoff instruction
  const handoffKeywords = parseArray(agent.handoff_keywords, []);
  if (handoffKeywords.length > 0) {
    prompt += `\n\nSe o cliente pedir para falar com um humano ou atendente, responda educadamente que irá transferir.`;
  }

  // Add required variables instructions
  const requiredVars = parseRequiredVariables(agent.required_variables);
  if (requiredVars.length > 0) {
    const varList = requiredVars.map(v => `- "${v.name}": pergunta "${v.question}"`).join('\n');
    prompt += `\n\nVARIÁVEIS OBRIGATÓRIAS - Você DEVE coletar estas informações durante a conversa de forma natural:
${varList}
- Colete uma informação por vez, de forma natural e amigável.
- Quando o cliente fornecer uma informação, confirme e passe para a próxima.
- Antes de qualquer transferência para humano, verifique se todas foram coletadas.
- Se alguma estiver faltando, pergunte antes de transferir.
- Armazene as respostas internamente para uso posterior.`;
  }

  return prompt;
}

// ==================== TOOLS ====================

// Import tool builders from ai-agents route - we re-export them here
// Since the tool builders are defined in ai-agents.js, we recreate them here
// to avoid circular dependencies

async function buildToolsForAgent(agent, capabilities, organizationId) {
  const tools = [];

  if (capabilities.includes('create_deals')) {
    const funnelsResult = await query(
      `SELECT f.id, f.name, json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.position) as stages
       FROM crm_funnels f
       JOIN crm_stages s ON s.funnel_id = f.id
       WHERE f.organization_id = $1
       GROUP BY f.id, f.name`,
      [organizationId]
    );
    if (funnelsResult.rows.length > 0) {
      tools.push(buildCreateDealTool(funnelsResult.rows));
    }
  }

  if (capabilities.includes('manage_tasks')) {
    tools.push(buildManageTasksTool());
  }

  if (capabilities.includes('qualify_leads')) {
    tools.push(buildQualifyLeadsTool());
  }

  if (capabilities.includes('summarize_history')) {
    tools.push(buildSummarizeHistoryTool());
  }

  if (capabilities.includes('schedule_meetings')) {
    tools.push(buildScheduleMeetingsTool());
  }

  if (capabilities.includes('google_calendar')) {
    tools.push(buildGoogleCalendarTool());
  }

  if (capabilities.includes('suggest_actions')) {
    tools.push(buildSuggestActionsTool());
  }

  if (capabilities.includes('generate_content')) {
    tools.push(buildGenerateContentTool());
  }

  if (capabilities.includes('call_agent')) {
    const callConfig = typeof agent.call_agent_config === 'string'
      ? JSON.parse(agent.call_agent_config || '{}')
      : (agent.call_agent_config || {});

    let agentFilter = `organization_id = $1 AND id != $2 AND is_active = true`;
    const params = [organizationId, agent.id];
    if (!callConfig.allow_all && callConfig.allowed_agent_ids?.length > 0) {
      agentFilter += ` AND id = ANY($3)`;
      params.push(callConfig.allowed_agent_ids);
    }

    const otherAgentsResult = await query(
      `SELECT id, name, description, system_prompt FROM ai_agents WHERE ${agentFilter}`,
      params
    );

    if (otherAgentsResult.rows.length > 0) {
      tools.push(buildCallAgentTool(otherAgentsResult.rows));
    }
  }

  return tools;
}

// ==================== TOOL DEFINITIONS (mirrored from ai-agents.js) ====================

function buildCreateDealTool(funnels) {
  const funnelDesc = funnels.map(f => `- Funil "${f.name}" (id: ${f.id}), etapas: ${f.stages.map(s => `"${s.name}" (id: ${s.id})`).join(', ')}`).join('\n');
  return {
    type: 'function',
    function: {
      name: 'create_deal',
      description: `Cria um novo negócio/deal no CRM. Funis disponíveis:\n${funnelDesc}`,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título do negócio' },
          value: { type: 'number', description: 'Valor do negócio em reais' },
          funnel_id: { type: 'string', description: 'ID do funil' },
          stage_id: { type: 'string', description: 'ID da etapa no funil' },
          description: { type: 'string', description: 'Descrição do negócio' },
        },
        required: ['title', 'funnel_id', 'stage_id'],
      },
    },
  };
}

function buildManageTasksTool() {
  return {
    type: 'function',
    function: {
      name: 'manage_tasks',
      description: 'Cria ou lista tarefas no CRM.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list'] },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          type: { type: 'string', enum: ['task', 'call', 'meeting', 'email', 'follow_up'] },
          due_date: { type: 'string' },
        },
        required: ['action'],
      },
    },
  };
}

function buildQualifyLeadsTool() {
  return {
    type: 'function',
    function: {
      name: 'qualify_lead',
      description: 'Qualifica um lead com pontuação de 0 a 100.',
      parameters: {
        type: 'object',
        properties: {
          score: { type: 'number' },
          qualification: { type: 'string', enum: ['cold', 'warm', 'hot', 'very_hot'] },
          reasoning: { type: 'string' },
          recommended_action: { type: 'string' },
        },
        required: ['score', 'qualification', 'reasoning'],
      },
    },
  };
}

function buildSummarizeHistoryTool() {
  return {
    type: 'function',
    function: {
      name: 'summarize_conversation',
      description: 'Gera um resumo da conversa.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          key_points: { type: 'string' },
          customer_sentiment: { type: 'string', enum: ['very_negative', 'negative', 'neutral', 'positive', 'very_positive'] },
          next_steps: { type: 'string' },
        },
        required: ['summary', 'key_points', 'customer_sentiment'],
      },
    },
  };
}

function buildScheduleMeetingsTool() {
  return {
    type: 'function',
    function: {
      name: 'schedule_meeting',
      description: 'Agenda uma reunião criando tarefa no CRM.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: { type: 'string' },
          duration_minutes: { type: 'number' },
          attendees: { type: 'string' },
          location: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['title', 'date'],
      },
    },
  };
}

function buildGoogleCalendarTool() {
  return {
    type: 'function',
    function: {
      name: 'google_calendar_event',
      description: `Gerencia agenda inteligente. Ações:
- "find_available_slots": Busca horários livres respeitando horário comercial.
- "create": Cria evento verificando conflitos.
- "list": Lista próximos eventos.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'find_available_slots'] },
          title: { type: 'string' },
          start_time: { type: 'string' },
          end_time: { type: 'string' },
          description: { type: 'string' },
          duration_minutes: { type: 'number' },
          days_ahead: { type: 'number' },
          preferred_period: { type: 'string', enum: ['morning', 'afternoon', 'any'] },
        },
        required: ['action'],
      },
    },
  };
}

function buildSuggestActionsTool() {
  return {
    type: 'function',
    function: {
      name: 'suggest_actions',
      description: 'Sugere próximas ações com base no contexto da conversa.',
      parameters: {
        type: 'object',
        properties: {
          suggestions: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
          context_summary: { type: 'string' },
          category: { type: 'string', enum: ['sales', 'support', 'follow_up', 'upsell', 'retention', 'general'] },
        },
        required: ['suggestions', 'urgency', 'context_summary'],
      },
    },
  };
}

function buildGenerateContentTool() {
  return {
    type: 'function',
    function: {
      name: 'generate_content',
      description: 'Gera conteúdo de texto como follow-ups, propostas, emails.',
      parameters: {
        type: 'object',
        properties: {
          content_type: { type: 'string', enum: ['follow_up_message', 'proposal', 'email', 'call_script', 'whatsapp_template', 'other'] },
          title: { type: 'string' },
          content: { type: 'string' },
          tone: { type: 'string', enum: ['formal', 'informal', 'professional', 'friendly', 'persuasive'] },
        },
        required: ['content_type', 'title', 'content'],
      },
    },
  };
}

function buildCallAgentTool(availableAgents) {
  const agentDescriptions = availableAgents.map(a => `- ${a.name}: ${a.description || 'Agente especialista'}`).join('\n');
  return {
    type: 'function',
    function: {
      name: 'consult_specialist_agent',
      description: `Consulta outro agente especialista.\n${agentDescriptions}`,
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['agent_name', 'question'],
      },
    },
  };
}

// ==================== TOOL EXECUTOR ====================

function createToolExecutor(organizationId, userId) {
  return async (toolName, args) => {
    switch (toolName) {
      case 'create_deal':
        return executeCreateDeal(organizationId, userId, args);
      case 'manage_tasks':
        return executeManageTasks(organizationId, userId, args);
      case 'qualify_lead':
        return executeQualifyLead(organizationId, args);
      case 'summarize_conversation':
        return executeSummarizeHistory(args);
      case 'schedule_meeting':
        return executeScheduleMeeting(organizationId, userId, args);
      case 'google_calendar_event':
        return executeGoogleCalendar(organizationId, userId, args);
      case 'suggest_actions':
        return executeSuggestActions(args);
      case 'generate_content':
        return executeGenerateContent(args);
      case 'consult_specialist_agent':
        return executeCallAgent(organizationId, args.agent_name, args.question);
      default:
        return 'Ferramenta desconhecida';
    }
  };
}

// ==================== TOOL EXECUTORS ====================

async function executeCreateDeal(organizationId, userId, args) {
  try {
    const result = await query(`
      INSERT INTO crm_deals (organization_id, funnel_id, stage_id, title, value, description, created_by, owner_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
      RETURNING id, title, value
    `, [organizationId, args.funnel_id, args.stage_id, args.title, args.value || 0, args.description || null, userId]);
    const deal = result.rows[0];
    return `Negócio "${deal.title}" criado (ID: ${deal.id}, R$ ${deal.value})`;
  } catch (error) {
    return `Erro ao criar negócio: ${error.message}`;
  }
}

async function executeManageTasks(organizationId, userId, args) {
  try {
    if (args.action === 'create') {
      if (!args.title) return 'Título da tarefa é obrigatório';
      const result = await query(`
        INSERT INTO crm_tasks (organization_id, assigned_to, created_by, title, description, type, priority, due_date)
        VALUES ($1, $2, $2, $3, $4, $5, $6, $7)
        RETURNING id, title, priority, due_date
      `, [organizationId, userId, args.title, args.description || null, args.type || 'task', args.priority || 'medium', args.due_date || null]);
      const task = result.rows[0];

      // Also create kanban card
      try {
        const { createTaskCardInGlobalBoard } = await import('./task-card-helper.js');
        await createTaskCardInGlobalBoard({
          organizationId, createdBy: userId, assignedTo: userId,
          title: args.title, description: args.description,
          priority: args.priority || 'medium', dueDate: args.due_date,
          sourceModule: 'ai_agent', crmTaskId: task.id,
        });
      } catch (e) { /* ignore */ }

      return `Tarefa "${task.title}" criada (prioridade: ${task.priority})`;
    } else {
      const result = await query(`
        SELECT id, title, priority, type, due_date, status FROM crm_tasks
        WHERE organization_id = $1 AND status IN ('pending', 'in_progress')
        ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
        LIMIT 10
      `, [organizationId]);
      if (result.rows.length === 0) return 'Nenhuma tarefa pendente.';
      return result.rows.map(t => `- [${t.priority}] ${t.title} (${t.type})`).join('\n');
    }
  } catch (error) {
    return `Erro: ${error.message}`;
  }
}

async function executeQualifyLead(organizationId, args) {
  logInfo('ai_agent_processor.qualify_lead', { score: args.score, qualification: args.qualification });
  return JSON.stringify({ score: args.score, qualification: args.qualification, reasoning: args.reasoning });
}

async function executeSummarizeHistory(args) {
  return JSON.stringify({
    summary: args.summary,
    key_points: (args.key_points || '').split('|').map(s => s.trim()).filter(Boolean),
    customer_sentiment: args.customer_sentiment,
  });
}

async function resolveUserInOrg(organizationId, nameOrEmail) {
  if (!nameOrEmail) return null;
  const result = await query(`
    SELECT u.id, u.name, u.email FROM users u
    JOIN organization_members om ON om.user_id = u.id
    WHERE om.organization_id = $1 AND (u.name ILIKE $2 OR u.email ILIKE $2)
    LIMIT 1
  `, [organizationId, `%${nameOrEmail.trim()}%`]);
  return result.rows[0] || null;
}

async function executeScheduleMeeting(organizationId, userId, args) {
  try {
    let assignedUserId = userId;
    let assignedUserName = null;
    if (args.assigned_to_name) {
      const resolved = await resolveUserInOrg(organizationId, args.assigned_to_name);
      if (resolved) {
        assignedUserId = resolved.id;
        assignedUserName = resolved.name;
      } else {
        return `Usuário "${args.assigned_to_name}" não encontrado na organização.`;
      }
    }

    const action = args.action || 'create';

    if (action === 'check_agenda') {
      const daysAhead = args.days_ahead || 7;
      const result = await query(`
        SELECT title, type, due_date, status, priority FROM crm_tasks
        WHERE organization_id = $1 AND assigned_to = $2
          AND status IN ('pending', 'in_progress')
          AND due_date >= NOW() AND due_date <= NOW() + interval '1 day' * $3
        ORDER BY due_date ASC LIMIT 20
      `, [organizationId, assignedUserId, daysAhead]);
      if (result.rows.length === 0) {
        return `📋 Agenda de ${assignedUserName || 'responsável'} está livre nos próximos ${daysAhead} dias.`;
      }
      const items = result.rows.map(t => {
        const d = new Date(t.due_date);
        return `- [${t.type}] ${t.title} — ${d.toLocaleDateString('pt-BR')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')} (${t.priority})`;
      }).join('\n');
      return `📋 Agenda de ${assignedUserName || 'responsável'} (próximos ${daysAhead} dias):\n${items}`;
    }

    if (action === 'find_available_slots') {
      const daysAhead = args.days_ahead || 7;
      const schedule = await getWorkSchedule(organizationId);
      const slotDuration = args.duration_minutes || schedule.slot_duration_minutes;
      const slots = await findAvailableSlotsForUser(organizationId, assignedUserId, daysAhead, slotDuration, args.preferred_period, schedule);
      if (slots.length === 0) return `Nenhum horário disponível para ${assignedUserName || 'responsável'} nos próximos ${daysAhead} dias.`;
      const slotList = slots.map((s, i) => `${i + 1}. ${s.day_of_week} ${s.date} das ${s.start} às ${s.end}`).join('\n');
      return `Horários disponíveis de ${assignedUserName || 'responsável'}:\n${slotList}`;
    }

    // CREATE
    if (!args.title || !args.date) return 'Título e data são obrigatórios.';
    const durationMin = args.duration_minutes || 60;

    const conflictResult = await query(`
      SELECT id, title, due_date FROM crm_tasks
      WHERE organization_id = $1 AND assigned_to = $2 AND type IN ('meeting', 'call')
        AND status IN ('pending', 'in_progress')
        AND due_date >= $3::timestamp - interval '1 hour'
        AND due_date <= $3::timestamp + interval '1 hour'
    `, [organizationId, assignedUserId, args.date]);

    if (conflictResult.rows.length > 0) {
      const conflicts = conflictResult.rows.map(c => {
        const d = new Date(c.due_date);
        return `"${c.title}" (${d.toLocaleDateString('pt-BR')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')})`;
      }).join(', ');
      return `⚠️ Conflito na agenda de ${assignedUserName || 'responsável'}: ${conflicts}. Use find_available_slots.`;
    }

    const result = await query(`
      INSERT INTO crm_tasks (organization_id, assigned_to, created_by, title, description, type, priority, due_date)
      VALUES ($1, $2, $3, $4, $5, 'meeting', 'high', $6)
      RETURNING id, title, due_date
    `, [organizationId, assignedUserId, userId, args.title,
      `Participantes: ${args.attendees || 'A definir'}\nLocal: ${args.location || 'A definir'}\nDuração: ${durationMin}min\n${args.notes || ''}`.trim(),
      args.date
    ]);
    return `✅ Reunião "${result.rows[0].title}" agendada para ${result.rows[0].due_date} com ${assignedUserName || 'responsável'} (duração: ${durationMin}min). Sem conflitos.`;
  } catch (error) {
    return `Erro: ${error.message}`;
  }
}

async function executeGoogleCalendar(organizationId, userId, args) {
  try {
    if (args.action === 'find_available_slots') {
      const daysAhead = args.days_ahead || 7;
      const schedule = await getWorkSchedule(organizationId);
      const slotDuration = args.duration_minutes || schedule.slot_duration_minutes;
      const slots = await findAvailableSlots(organizationId, daysAhead, slotDuration, args.preferred_period, schedule);
      
      if (slots.length === 0) return `Nenhum horário disponível nos próximos ${daysAhead} dias.`;
      
      const slotList = slots.map((s, i) => `${i + 1}. ${s.day_of_week} ${s.date} das ${s.start} às ${s.end}`).join('\n');
      return `Horários disponíveis:\n${slotList}`;
    }
    
    if (args.action === 'create') {
      if (!args.title || !args.start_time) return 'Título e horário são obrigatórios.';
      
      // Check conflicts
      const conflictResult = await query(`
        SELECT id, title, due_date FROM crm_tasks
        WHERE organization_id = $1 AND type = 'meeting' AND status = 'pending'
          AND due_date >= $2::timestamp - interval '1 hour'
          AND due_date <= $2::timestamp + interval '1 hour'
      `, [organizationId, args.start_time]);
      
      if (conflictResult.rows.length > 0) {
        return `⚠️ Conflito com: ${conflictResult.rows.map(c => `"${c.title}"`).join(', ')}. Use find_available_slots.`;
      }
      
      const result = await query(`
        INSERT INTO crm_tasks (organization_id, assigned_to, created_by, title, description, type, priority, due_date)
        VALUES ($1, $2, $2, $3, $4, 'meeting', 'medium', $5)
        RETURNING id, title, due_date
      `, [organizationId, userId, args.title, args.description || '', args.start_time]);
      
      return `✅ Evento "${result.rows[0].title}" agendado para ${args.start_time}`;
    }
    
    // List
    const daysAhead = args.days_ahead || 7;
    const result = await query(`
      SELECT title, due_date FROM crm_tasks
      WHERE organization_id = $1 AND type = 'meeting' AND status = 'pending'
        AND due_date >= NOW() AND due_date <= NOW() + interval '1 day' * $2
      ORDER BY due_date ASC LIMIT 15
    `, [organizationId, daysAhead]);
    if (result.rows.length === 0) return 'Nenhum evento nos próximos dias.';
    return result.rows.map(e => `- ${e.title} (${e.due_date})`).join('\n');
  } catch (error) {
    return `Erro: ${error.message}`;
  }
}

async function executeSuggestActions(args) {
  return JSON.stringify({
    suggestions: (args.suggestions || '').split('|').map(s => s.trim()).filter(Boolean),
    urgency: args.urgency,
    context_summary: args.context_summary,
  });
}

async function executeGenerateContent(args) {
  return JSON.stringify({
    content_type: args.content_type,
    title: args.title,
    content: args.content,
    tone: args.tone || 'professional',
  });
}

async function executeCallAgent(organizationId, agentName, question) {
  try {
    const agentResult = await query(
      `SELECT * FROM ai_agents WHERE organization_id = $1 AND name ILIKE $2 AND is_active = true LIMIT 1`,
      [organizationId, `%${agentName}%`]
    );
    if (agentResult.rows.length === 0) return `Agente "${agentName}" não encontrado.`;

    const specialist = agentResult.rows[0];
    const aiConfig = await getAgentAIConfig(specialist, organizationId);

    const knowledgeResult = await query(
      `SELECT source_content FROM ai_knowledge_sources WHERE agent_id = $1 AND is_active = true ORDER BY priority DESC`,
      [specialist.id]
    );
    const knowledgeContext = knowledgeResult.rows.map(k => k.source_content).join('\n\n');
    const systemPrompt = `${specialist.system_prompt || 'Você é um assistente.'}\n\n${knowledgeContext ? `Base de conhecimento:\n${knowledgeContext}` : ''}`;

    const result = await callAI(aiConfig, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ], { temperature: specialist.temperature || 0.7, maxTokens: specialist.max_tokens || 1000 });

    return result.content || 'Sem resposta do especialista.';
  } catch (error) {
    return `Erro ao consultar agente: ${error.message}`;
  }
}

// ==================== WORK SCHEDULE HELPERS ====================

async function getWorkSchedule(organizationId) {
  const result = await query(`SELECT work_schedule FROM organizations WHERE id = $1`, [organizationId]);
  const raw = result.rows[0]?.work_schedule;
  const schedule = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  return {
    timezone: schedule.timezone || 'America/Sao_Paulo',
    work_days: schedule.work_days || [1, 2, 3, 4, 5],
    dayConfig: schedule.dayConfig || null,
    work_start: schedule.work_start || '08:00',
    work_end: schedule.work_end || '18:00',
    lunch_start: schedule.lunch_start || '12:00',
    lunch_end: schedule.lunch_end || '13:00',
    slot_duration_minutes: schedule.slot_duration_minutes || 60,
    buffer_minutes: schedule.buffer_minutes || 15,
  };
}

function timeToMinutes(timeStr) {
  const [h, m] = (timeStr || '08:00').split(':').map(Number);
  return h * 60 + m;
}

async function findAvailableSlots(organizationId, daysAhead, slotDuration, preferredPeriod, schedule) {
  return findAvailableSlotsForUser(organizationId, null, daysAhead, slotDuration, preferredPeriod, schedule);
}

async function findAvailableSlotsForUser(organizationId, userId, daysAhead, slotDuration, preferredPeriod, schedule) {
  const existingQuery = userId
    ? `SELECT due_date, due_date + interval '1 hour' as estimated_end
       FROM crm_tasks WHERE organization_id = $1 AND assigned_to = $3
         AND type IN ('meeting', 'call') AND status IN ('pending', 'in_progress')
         AND due_date >= NOW() AND due_date <= NOW() + interval '1 day' * $2
       ORDER BY due_date ASC`
    : `SELECT due_date, due_date + interval '1 hour' as estimated_end
       FROM crm_tasks WHERE organization_id = $1
         AND type IN ('meeting', 'call') AND status IN ('pending', 'in_progress')
         AND due_date >= NOW() AND due_date <= NOW() + interval '1 day' * $2
       ORDER BY due_date ASC`;

  const params = userId ? [organizationId, daysAhead, userId] : [organizationId, daysAhead];
  const existingResult = await query(existingQuery, params);

  const existingEvents = existingResult.rows.map(e => ({
    start: new Date(e.due_date).getTime(),
    end: new Date(e.estimated_end).getTime(),
  }));

  const workStartMin = timeToMinutes(schedule.work_start);
  const workEndMin = timeToMinutes(schedule.work_end);
  const lunchStartMin = timeToMinutes(schedule.lunch_start);
  const lunchEndMin = timeToMinutes(schedule.lunch_end);
  const buffer = schedule.buffer_minutes;
  const slots = [];
  const now = new Date();

  for (let d = 0; d < daysAhead && slots.length < 10; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    const dayConfig = schedule.dayConfig?.[String(date.getDay())] || schedule.dayConfig?.[date.getDay()];
    if (dayConfig && dayConfig.enabled === false) continue;
    if (!dayConfig && !schedule.work_days.includes(date.getDay())) continue;
    const dayStartMin = dayConfig ? timeToMinutes(dayConfig.start || dayConfig.entry) : workStartMin;
    const dayEndMin = dayConfig ? timeToMinutes(dayConfig.end || dayConfig.exit) : workEndMin;
    const dayLunchStartMin = dayConfig ? timeToMinutes(dayConfig.lunch_start) : lunchStartMin;
    const dayLunchEndMin = dayConfig ? timeToMinutes(dayConfig.lunch_end) : lunchEndMin;

    for (let min = dayStartMin; min + slotDuration <= dayEndMin && slots.length < 10; min += slotDuration + buffer) {
      if (min < dayLunchEndMin && min + slotDuration > dayLunchStartMin) {
        min = dayLunchEndMin - slotDuration - buffer;
        continue;
      }
      if (preferredPeriod === 'morning' && min >= dayLunchStartMin) continue;
      if (preferredPeriod === 'afternoon' && min < dayLunchEndMin) continue;

      const slotStart = new Date(date);
      slotStart.setHours(Math.floor(min / 60), min % 60, 0, 0);
      const slotEnd = new Date(slotStart.getTime() + slotDuration * 60000);

      if (slotStart.getTime() < now.getTime() + 30 * 60000) continue;

      const hasConflict = existingEvents.some(e => slotStart.getTime() < e.end && slotEnd.getTime() > e.start);
      if (hasConflict) continue;

      const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
      slots.push({
        date: slotStart.toISOString().split('T')[0],
        day_of_week: dayNames[slotStart.getDay()],
        start: `${String(slotStart.getHours()).padStart(2, '0')}:${String(slotStart.getMinutes()).padStart(2, '0')}`,
        end: `${String(slotEnd.getHours()).padStart(2, '0')}:${String(slotEnd.getMinutes()).padStart(2, '0')}`,
      });
    }
  }

  return slots;
}

// ==================== AGENT STATS ====================

async function updateAgentStats(agentId, tokensUsed, responseTimeMs, toolCalls) {
  try {
    const today = new Date().toISOString().split('T')[0];
    await query(`
      INSERT INTO ai_agent_stats (agent_id, date, total_messages, total_tokens_used, avg_response_time_ms,
        deals_created, meetings_scheduled, leads_qualified)
      VALUES ($1, $2, 1, $3, $4, $5, $6, $7)
      ON CONFLICT (agent_id, date) DO UPDATE SET
        total_messages = ai_agent_stats.total_messages + 1,
        total_tokens_used = ai_agent_stats.total_tokens_used + EXCLUDED.total_tokens_used,
        avg_response_time_ms = (ai_agent_stats.avg_response_time_ms + EXCLUDED.avg_response_time_ms) / 2,
        deals_created = ai_agent_stats.deals_created + EXCLUDED.deals_created,
        meetings_scheduled = ai_agent_stats.meetings_scheduled + EXCLUDED.meetings_scheduled,
        leads_qualified = ai_agent_stats.leads_qualified + EXCLUDED.leads_qualified
    `, [
      agentId, today, tokensUsed, responseTimeMs,
      toolCalls.some(tc => tc.name === 'create_deal') ? 1 : 0,
      toolCalls.some(tc => tc.name === 'schedule_meeting' || tc.name === 'google_calendar_event') ? 1 : 0,
      toolCalls.some(tc => tc.name === 'qualify_lead') ? 1 : 0,
    ]);
  } catch (error) {
    // Stats update is non-critical
    logError('ai_agent_processor.stats_update_error', error);
  }
}

// ==================== AI CONFIG ====================

async function getAgentAIConfig(agent, organizationId) {
  if (agent.ai_api_key) {
    return { provider: agent.ai_provider, model: agent.ai_model, apiKey: agent.ai_api_key };
  }

  const orgResult = await query(
    `SELECT ai_provider, ai_model, ai_api_key FROM organizations WHERE id = $1`,
    [organizationId]
  );
  const org = orgResult.rows[0];
  if (!org?.ai_api_key || org.ai_provider === 'none') {
    throw new Error('Nenhuma chave de API configurada para o agente.');
  }

  return {
    provider: org.ai_provider || agent.ai_provider,
    model: agent.ai_model || org.ai_model || 'gpt-4o-mini',
    apiKey: org.ai_api_key,
  };
}

// ==================== MANUAL SESSION CONTROL ====================

/**
 * Start an agent session for a conversation (manual activation from chat UI)
 * Seeds the session with recent chat history so the AI has context
 */
export async function startAgentSession(agentId, conversationId, contactPhone, contactName) {
  // End any existing active session first
  await query(
    `UPDATE ai_agent_sessions SET is_active = false, ended_at = NOW() 
     WHERE conversation_id = $1 AND is_active = true`,
    [conversationId]
  );

  const session = await createSession(agentId, conversationId, contactPhone, contactName);

  // Seed session with recent chat_messages so the AI can read conversation context
  try {
    const recentMessages = await query(`
      SELECT content, from_me, created_at FROM chat_messages
      WHERE conversation_id = $1 AND content IS NOT NULL AND content != ''
      ORDER BY created_at DESC LIMIT 10
    `, [conversationId]);

    if (recentMessages.rows.length > 0) {
      // Insert in chronological order (oldest first)
      const msgs = recentMessages.rows.reverse();
      for (const msg of msgs) {
        const role = msg.from_me ? 'assistant' : 'user';
        await query(
          `INSERT INTO ai_agent_messages (session_id, role, content, tokens_used)
           VALUES ($1, $2, $3, 0)`,
          [session.id, role, msg.content]
        );
      }
      logInfo('ai_agent_processor.session_seeded_with_history', {
        sessionId: session.id, conversationId, messagesSeeded: msgs.length,
      });
    }
  } catch (err) {
    logError('ai_agent_processor.session_seed_error', err);
    // Non-critical - session still works without history
  }

  return session;
}

/**
 * Trigger an immediate AI response after manual activation from CRM.
 * Uses the seeded chat history as context and sends a proactive message.
 */
export async function triggerAgentFirstMessage(agentId, conversationId) {
  try {
    const session = await getActiveSession(conversationId);
    if (!session) {
      logInfo('ai_agent_processor.first_message_no_session', { conversationId });
      return null;
    }

    // Load agent
    const agentResult = await query(`SELECT * FROM ai_agents WHERE id = $1`, [agentId]);
    if (agentResult.rows.length === 0) return null;
    const agent = agentResult.rows[0];

    // Get connection for this conversation
    const connResult = await query(
      `SELECT c.* FROM connections c JOIN conversations cv ON cv.connection_id = c.id WHERE cv.id = $1`,
      [conversationId]
    );
    if (connResult.rows.length === 0) return null;
    const connection = connResult.rows[0];
    const organizationId = connection.organization_id;

    // Load seeded history
    const history = await getSessionHistory(session.id, agent.context_window || 10);
    if (history.length === 0) {
      logInfo('ai_agent_processor.first_message_no_history', { conversationId });
      return null;
    }

    // Get the last user message content for RAG context
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    const contextMessage = lastUserMsg?.content || '';

    // Build system prompt with RAG
    const aiConfig = await getAgentAIConfig(agent, organizationId);
    const systemPrompt = await buildSystemPrompt(agent, organizationId, session.contact_name, contextMessage, aiConfig);

    // Build messages - add STRONG instruction to continue the conversation proactively
    // This must override any "ask for name" or "greet" instructions in the agent's base prompt
    const proactiveInstruction = `

=== INSTRUÇÃO PRIORITÁRIA (SOBRESCREVE QUALQUER OUTRA INSTRUÇÃO) ===
Você está sendo ativado MANUALMENTE por um atendente humano para CONTINUAR uma conversa já em andamento.
O histórico completo da conversa está abaixo. Você DEVE:
1. ANALISAR todo o histórico para entender o contexto e o assunto em discussão.
2. CONTINUAR a conversa de onde parou, dando seguimento ao assunto.
3. NÃO se apresentar como se fosse a primeira vez.
4. NÃO perguntar o nome do cliente (você já sabe: ${session.contact_name || 'veja no histórico'}).
5. NÃO perguntar "como posso ajudar" ou "em que posso ajudar".
6. NÃO pedir para o cliente repetir NADA — você já tem TODO o contexto.
7. Responder de forma proativa e útil, como se fosse o mesmo atendente continuando.
8. IGNORAR qualquer instrução anterior que diga para cumprimentar, pedir nome ou iniciar uma conversa do zero.
===`;

    const messages = [
      { role: 'system', content: systemPrompt + proactiveInstruction },
      ...history,
    ];

    // Build tools
    const capabilities = parseArray(agent.capabilities, ['respond_messages']);
    const tools = await buildToolsForAgent(agent, capabilities, organizationId);
    const userId = agent.default_user_id || agent.created_by;

    let result;
    let toolCallsExecuted = [];
    const startTime = Date.now();

    if (tools.length > 0) {
      const toolExecutor = createToolExecutor(organizationId, userId);
      result = await callAIWithTools(aiConfig, messages, {
        temperature: parseFloat(agent.temperature) || 0.7,
        maxTokens: parseInt(agent.max_tokens, 10) || 1000,
        tools,
      }, toolExecutor);
      toolCallsExecuted = result.toolCallsExecuted || [];
    } else {
      result = await callAI(aiConfig, messages, {
        temperature: parseFloat(agent.temperature) || 0.7,
        maxTokens: parseInt(agent.max_tokens, 10) || 1000,
      });
    }

    const responseTime = Date.now() - startTime;
    const responseText = result.content || '';

    if (!responseText) {
      logInfo('ai_agent_processor.first_message_empty_response', { conversationId });
      return null;
    }

    // Send message via WhatsApp
    await sendAgentMessage(connection, session.contact_phone, responseText, session.id);

    // Save to session history
    await saveAgentMessage(session.id, 'assistant', responseText, result.tokensUsed || 0, toolCallsExecuted);

    // Update stats
    await updateAgentStats(agentId, result.tokensUsed || 0, responseTime, toolCallsExecuted);

    logInfo('ai_agent_processor.first_message_sent', {
      sessionId: session.id, conversationId, responseTime, tokens: result.tokensUsed,
    });

    return { response: responseText, tokensUsed: result.tokensUsed };
  } catch (error) {
    logError('ai_agent_processor.first_message_error', error);
    return null;
  }
}

/**
 * Stop the active agent session for a conversation
 */
export async function stopAgentSession(conversationId) {
  const result = await query(
    `UPDATE ai_agent_sessions SET is_active = false, ended_at = NOW()
     WHERE conversation_id = $1 AND is_active = true RETURNING id, agent_id`,
    [conversationId]
  );
  return result.rows[0] || null;
}

/**
 * Get active session info for a conversation (used by chat UI)
 */
export async function getActiveAgentSession(conversationId) {
  const result = await query(
    `SELECT s.*, a.name as agent_name, a.avatar_url as agent_avatar
     FROM ai_agent_sessions s
     JOIN ai_agents a ON a.id = s.agent_id
     WHERE s.conversation_id = $1 AND s.is_active = true
     ORDER BY s.started_at DESC LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] || null;
}

/**
 * Pause the AI agent session when a human agent sends a message.
 * Uses the agent's configured takeover_timeout_seconds, or falls back to cooldownSeconds.
 */
export async function pauseSessionForHumanReply(conversationId, cooldownSeconds = 300) {
  // Try to get the agent's configured takeover timeout
  const sessionResult = await query(
    `SELECT s.id, a.takeover_timeout_seconds 
     FROM ai_agent_sessions s 
     JOIN ai_agents a ON a.id = s.agent_id 
     WHERE s.conversation_id = $1 AND s.is_active = true 
     ORDER BY s.started_at DESC LIMIT 1`,
    [conversationId]
  );
  
  const agentTimeout = sessionResult.rows[0]?.takeover_timeout_seconds;
  const timeoutSeconds = agentTimeout ? parseInt(agentTimeout, 10) : cooldownSeconds;
  
  const pauseUntil = new Date(Date.now() + timeoutSeconds * 1000);
  const result = await query(
    `UPDATE ai_agent_sessions SET paused_until = $2
     WHERE conversation_id = $1 AND is_active = true RETURNING id`,
    [conversationId, pauseUntil.toISOString()]
  );
  if (result.rows[0]) {
    logInfo('ai_agent_processor.paused_for_human', { conversationId, paused_until: pauseUntil, timeout_seconds: timeoutSeconds });
  }
  return result.rows[0] || null;
}

/**
 * Enable/disable human takeover for a conversation's AI agent session.
 * When enabled, the AI completely stops responding until re-enabled.
 */
export async function setHumanTakeover(conversationId, enabled, userId) {
  if (enabled) {
    const result = await query(
      `UPDATE ai_agent_sessions 
       SET human_takeover = true, human_takeover_by = $2, human_takeover_at = NOW(), paused_until = NULL
       WHERE conversation_id = $1 AND is_active = true RETURNING id, agent_id`,
      [conversationId, userId]
    );
    logInfo('ai_agent_processor.human_takeover_enabled', { conversationId, userId });
    return result.rows[0] || null;
  } else {
    const result = await query(
      `UPDATE ai_agent_sessions 
       SET human_takeover = false, human_takeover_by = NULL, human_takeover_at = NULL
       WHERE conversation_id = $1 AND is_active = true RETURNING id, agent_id`,
      [conversationId]
    );
    logInfo('ai_agent_processor.human_takeover_disabled', { conversationId });
    return result.rows[0] || null;
  }
}

// ==================== HELPERS ====================

function parseArray(value, defaultValue) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
    if (trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed); } catch { /* fall through */ }
    }
  }
  return defaultValue;
}

function parseRequiredVariables(value) {
  if (Array.isArray(value)) return value.filter(v => v && v.name && v.question);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(v => v && v.name && v.question) : [];
    } catch { return []; }
  }
  return [];
}

// ==================== INACTIVITY TIMEOUT ====================

/**
 * Check all active sessions for inactivity and send closing messages.
 * Should be called periodically (e.g., every minute via scheduler).
 */
export async function checkInactivityTimeouts() {
  try {
    const schemaReady = await hasTables(['ai_agent_sessions', 'ai_agents', 'conversations']);
    if (!schemaReady) return 0;

    const result = await query(
      `SELECT s.id, s.conversation_id, s.contact_phone, s.agent_id, s.last_interaction_at,
              a.inactivity_timeout_minutes, a.inactivity_message, a.name as agent_name,
              c.connection_id
       FROM ai_agent_sessions s
       JOIN ai_agents a ON a.id = s.agent_id
       JOIN conversations c ON c.id = s.conversation_id
       WHERE s.is_active = true 
         AND a.inactivity_timeout_minutes > 0
         AND s.last_interaction_at < NOW() - (a.inactivity_timeout_minutes || ' minutes')::interval
         AND s.human_takeover = false`
    );

    for (const session of result.rows) {
      try {
        // Get connection for sending
        const connResult = await query(
          `SELECT * FROM connections WHERE id = $1`,
          [session.connection_id]
        );
        if (!connResult.rows[0]) continue;

        const connection = connResult.rows[0];
        const closingMsg = session.inactivity_message || 
          'Como não recebi sua resposta, vou encerrar nosso atendimento por aqui. Se precisar, é só me chamar novamente! 😊';

        // Send typing + closing message
        try {
          await whatsappProvider.sendPresenceComposing(connection, session.contact_phone);
          await sleep(1500);
        } catch (_e) { /* non-critical */ }

        await sendAgentMessage(connection, session.contact_phone, closingMsg, session.id);
        await saveAgentMessage(session.id, 'assistant', closingMsg, 0);

        // End session
        await endSession(session.id, 'inactivity_timeout');

        logInfo('ai_agent_processor.inactivity_timeout', {
          sessionId: session.id,
          agentName: session.agent_name,
          conversationId: session.conversation_id,
          minutesSinceLastInteraction: session.inactivity_timeout_minutes,
        });
      } catch (err) {
        logError('ai_agent_processor.inactivity_timeout_error', err);
      }
    }

    return result.rows.length;
  } catch (error) {
    logError('ai_agent_processor.check_inactivity_error', error);
    return 0;
  }
}

// ==================== MEDIA HELPERS ====================

/**
 * Resolve media URL to an absolute URL fetchable from the backend
 */
function resolveMediaUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url) || /^data:/i.test(url)) return url;
  const base = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
}

/**
 * Transcribe audio using the agent's own AI provider (OpenAI or Gemini)
 * Falls back to LOVABLE_API_KEY if available
 */
async function transcribeAudio(audioUrl, mimetype, aiConfig) {
  try {
    // Resolve URL to absolute
    const resolvedUrl = resolveMediaUrl(audioUrl);
    if (!resolvedUrl) {
      logError('ai_agent_processor.transcribe_no_url', new Error('No audio URL'));
      return null;
    }

    logInfo('ai_agent_processor.transcribe_downloading', { url: resolvedUrl?.slice(0, 120), provider: aiConfig?.provider });

    // Download audio to buffer
    const audioResponse = await fetch(resolvedUrl);
    if (!audioResponse.ok) {
      logError('ai_agent_processor.transcribe_download_failed', new Error(`HTTP ${audioResponse.status}`), { url: resolvedUrl?.slice(0, 120) });
      return null;
    }

    const audioBuffer = await audioResponse.arrayBuffer();
    
    if (audioBuffer.byteLength < 100) {
      logError('ai_agent_processor.transcribe_empty_audio', new Error('Audio file too small'));
      return null;
    }

    const mimeType = mimetype || 'audio/ogg';

    logInfo('ai_agent_processor.transcribe_start', { size: audioBuffer.byteLength, mimetype: mimeType, provider: aiConfig?.provider });

    // Try with agent's own API key first
    if (aiConfig?.apiKey) {
      if (aiConfig.provider === 'openai') {
        // Use OpenAI Whisper API for transcription
        const transcript = await transcribeWithOpenAI(audioBuffer, mimeType, aiConfig.apiKey);
        if (transcript) return transcript;
      } else if (aiConfig.provider === 'gemini') {
        // Use Gemini for transcription
        const transcript = await transcribeWithGemini(audioBuffer, mimeType, aiConfig.apiKey, aiConfig.model);
        if (transcript) return transcript;
      }
    }

    // Fallback: try LOVABLE_API_KEY with Gemini gateway
    const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
    if (LOVABLE_API_KEY) {
      const transcript = await transcribeWithLovableGateway(audioBuffer, mimeType, LOVABLE_API_KEY);
      if (transcript) return transcript;
    }

    logError('ai_agent_processor.transcribe_no_provider', new Error('No AI provider available for transcription'));
    return null;
  } catch (error) {
    logError('ai_agent_processor.transcribe_error', error);
    return null;
  }
}

/**
 * Transcribe using OpenAI Whisper API
 */
async function transcribeWithOpenAI(audioBuffer, mimeType, apiKey) {
  try {
    const ext = mimeType.includes('mp3') ? 'mp3' :
                mimeType.includes('wav') ? 'wav' :
                mimeType.includes('ogg') ? 'ogg' :
                mimeType.includes('webm') ? 'webm' :
                mimeType.includes('m4a') ? 'm4a' : 'ogg';

    const boundary = '----FormBoundary' + Date.now();
    const fileName = `audio.${ext}`;

    const formParts = [];
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\npt\r\n`);
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(formParts.join('') + fileHeader, 'utf-8');
    const audioBuf = Buffer.from(audioBuffer);
    const footerBuf = Buffer.from(fileFooter, 'utf-8');
    const body = Buffer.concat([headerBuf, audioBuf, footerBuf]);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logError('ai_agent_processor.transcribe_openai_error', new Error(`Whisper error ${response.status}`), { body: errText?.slice(0, 300) });
      return null;
    }

    const data = await response.json();
    const transcript = data.text?.trim() || null;
    logInfo('ai_agent_processor.transcribe_openai_success', { length: transcript?.length, preview: transcript?.slice(0, 80) });
    return transcript;
  } catch (error) {
    logError('ai_agent_processor.transcribe_openai_catch', error);
    return null;
  }
}

/**
 * Transcribe using Google Gemini API directly
 */
async function transcribeWithGemini(audioBuffer, mimeType, apiKey, model) {
  try {
    const base64Audio = Buffer.from(audioBuffer).toString('base64');
    const geminiModel = model || 'gemini-2.0-flash';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'Transcreva o seguinte áudio em português com precisão. Retorne APENAS o texto transcrito, sem explicações. Se inaudível, retorne "[Áudio inaudível]".' },
              { inline_data: { mime_type: mimeType, data: base64Audio } }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2000 }
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logError('ai_agent_processor.transcribe_gemini_error', new Error(`Gemini error ${response.status}`), { body: errText?.slice(0, 300) });
      return null;
    }

    const data = await response.json();
    const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    logInfo('ai_agent_processor.transcribe_gemini_success', { length: transcript?.length, preview: transcript?.slice(0, 80) });
    return transcript;
  } catch (error) {
    logError('ai_agent_processor.transcribe_gemini_catch', error);
    return null;
  }
}

/**
 * Transcribe using Lovable AI Gateway (fallback)
 */
async function transcribeWithLovableGateway(audioBuffer, mimeType, lovableApiKey) {
  try {
    const base64Audio = Buffer.from(audioBuffer).toString('base64');
    const audioFormat = mimeType.includes('mp3') ? 'mp3' :
                        mimeType.includes('wav') ? 'wav' :
                        mimeType.includes('ogg') ? 'ogg' :
                        mimeType.includes('webm') ? 'webm' : 'mp3';

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'Transcreva o áudio com precisão em português. Retorne APENAS o texto transcrito. Se inaudível, retorne "[Áudio inaudível]".' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Transcreva o seguinte áudio:' },
              { type: 'input_audio', input_audio: { data: base64Audio, format: audioFormat } }
            ]
          }
        ],
      }),
    });

    if (!response.ok) {
      logError('ai_agent_processor.transcribe_gateway_error', new Error(`Gateway error ${response.status}`));
      return null;
    }

    const data = await response.json();
    const transcript = data.choices?.[0]?.message?.content?.trim() || null;
    logInfo('ai_agent_processor.transcribe_gateway_success', { length: transcript?.length });
    return transcript;
  } catch (error) {
    logError('ai_agent_processor.transcribe_gateway_catch', error);
    return null;
  }
}

/**
 * Build a multimodal message content array for image messages
 * Downloads the image and converts to base64 data URI so both OpenAI and Gemini can access it
 */
async function buildImageMessage(imageUrl, caption) {
  const content = [];

  if (caption) {
    content.push({ type: 'text', text: caption });
  } else {
    content.push({ type: 'text', text: 'O cliente enviou esta imagem. Descreva o que você vê e responda adequadamente.' });
  }

  const resolvedUrl = resolveMediaUrl(imageUrl);
  let finalUrl = resolvedUrl || imageUrl;

  // Download and convert to base64 data URI so external AI APIs can access local images
  if (finalUrl && !finalUrl.startsWith('data:')) {
    try {
      const imgResp = await fetch(finalUrl);
      if (imgResp.ok) {
        const imgBuf = await imgResp.arrayBuffer();
        const bytes = new Uint8Array(imgBuf);
        const chunkSize = 8192;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
          for (let j = 0; j < chunk.length; j++) {
            binary += String.fromCharCode(chunk[j]);
          }
        }
        const b64 = Buffer.from(imgBuf).toString('base64');
        const contentType = imgResp.headers.get('content-type') || 'image/jpeg';
        finalUrl = `data:${contentType};base64,${b64}`;
        logInfo('ai_agent_processor.image_converted_to_base64', { originalUrl: resolvedUrl?.slice(0, 100), size: imgBuf.byteLength });
      } else {
        logError('ai_agent_processor.image_download_failed', new Error(`HTTP ${imgResp.status}`), { url: resolvedUrl?.slice(0, 100) });
      }
    } catch (err) {
      logError('ai_agent_processor.image_download_error', err, { url: resolvedUrl?.slice(0, 100) });
    }
  }

  content.push({
    type: 'image_url',
    image_url: { url: finalUrl },
  });

  return content;
}

/**
 * Build multimodal message for document - try to read if possible
 * For PDFs and images disguised as documents, convert to base64 for AI vision
 */
async function buildDocumentMessage(mediaUrl, filename, caption, mimetype) {
  try {
    const resolvedDocUrl = resolveMediaUrl(mediaUrl);

    // For text-based documents, try to download and include content
    const textTypes = ['text/', 'application/json', 'application/xml', 'text/csv'];
    const isTextBased = textTypes.some(t => (mimetype || '').includes(t));
    
    if (isTextBased && resolvedDocUrl) {
      const resp = await fetch(resolvedDocUrl);
      if (resp.ok) {
        const textContent = await resp.text();
        const truncated = textContent.substring(0, 3000);
        return `[Documento recebido: ${filename}]\n\nConteúdo do documento:\n${truncated}${textContent.length > 3000 ? '\n... (conteúdo truncado)' : ''}${caption ? `\n\nLegenda: ${caption}` : ''}`;
      }
    }

    // For PDFs and image-based documents, download and send as base64 for AI vision
    const visionTypes = ['application/pdf', 'image/'];
    const isVisionCapable = visionTypes.some(t => (mimetype || '').includes(t));

    if (isVisionCapable && resolvedDocUrl) {
      try {
        const resp = await fetch(resolvedDocUrl);
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          const b64 = Buffer.from(buf).toString('base64');
          const contentType = resp.headers.get('content-type') || mimetype || 'application/pdf';
          logInfo('ai_agent_processor.document_converted_to_base64', { filename, size: buf.byteLength, contentType });

          // Return multimodal content array for the AI
          const parts = [];
          parts.push({ 
            type: 'text', 
            text: caption 
              ? `O cliente enviou o documento "${filename}" com a legenda: "${caption}". Analise o conteúdo e responda.` 
              : `O cliente enviou o documento "${filename}". Analise o conteúdo e responda adequadamente.`
          });

          // For PDFs, some providers support file content via image_url with data URI
          if (contentType.includes('pdf')) {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${contentType};base64,${b64}` },
            });
          } else if (contentType.startsWith('image/')) {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${contentType};base64,${b64}` },
            });
          }

          return parts;
        }
      } catch (err) {
        logError('ai_agent_processor.document_vision_error', err, { filename });
      }
    }
    
    return `[Documento recebido: ${filename}]${caption ? ` - ${caption}` : ''}. Responda reconhecendo o recebimento do documento e pergunte se o cliente precisa de ajuda com algo relacionado.`;
  } catch (error) {
    logError('ai_agent_processor.document_read_error', error);
    return `[Documento recebido: ${filename}]${caption ? ` - ${caption}` : ''}`;
  }
}
