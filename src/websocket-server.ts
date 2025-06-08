
'use server';
import { WebSocketServer, WebSocket } from 'ws';
import { config as dotenvConfig } from 'dotenv';
import { improveTranslationAccuracy, type ImproveTranslationAccuracyInput } from './ai/flows/improve-translation-accuracy';
import { transcribeAudio, type TranscribeAudioInput } from './ai/flows/transcribe-audio-flow';

dotenvConfig(); 

const PORT = parseInt(process.env.NEXT_PUBLIC_WEBSOCKET_PORT || process.env.WEBSOCKET_PORT || '3001', 10);

const wss = new WebSocketServer({ port: PORT });

console.log(`[WebSocketServer] Iniciado em ws://localhost:${PORT}`);

const audioSubscribers = new Set<WebSocket>();

// Cache para evitar re-processamento desnecessário
let lastProcessedInfo: {
  // Para áudio do sistema, o originalText pode ser um placeholder. O audioHash seria ideal.
  // Por simplicidade, usaremos o originalText (que o cliente agora torna único).
  originalText: string; 
  sourceLanguage: string;
  targetLanguage: string;
  translatedText: string;
  // Idealmente, adicionar um hash do áudio para áudio do sistema
  // audioHash?: string; 
} | null = null;

wss.on('connection', (ws: WebSocket) => {
  console.log('[WebSocketServer] Cliente conectado');

  ws.on('message', async (message: Buffer) => {
    let parsedData: any;
    try {
      const dataString = message.toString();
      parsedData = JSON.parse(dataString);
    } catch (e) {
      console.warn(`[WebSocketServer] Falha ao parsear JSON: "${message.toString().substring(0,100)}..."`, e);
      if (ws.readyState === WebSocket.OPEN) {
       ws.send(JSON.stringify({ error: `Formato de mensagem inválido (não é JSON)` }));
      }
      return;
    }

    if (parsedData.action === 'subscribe_audio') {
      audioSubscribers.add(ws);
      console.log('[WebSocketServer] Novo assinante de áudio adicionado. Total:', audioSubscribers.size);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ message: 'Inscrito para receber áudio traduzido.' }));
      }
      if (lastProcessedInfo && lastProcessedInfo.translatedText) {
        console.log(`[WebSocketServer] Enviando última tradução conhecida para novo assinante: "${lastProcessedInfo.translatedText.substring(0,30)}..."`);
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'translated_text_for_listener',
              text: lastProcessedInfo.translatedText,
              targetLanguage: lastProcessedInfo.targetLanguage
            }));
          } catch (sendError) {
            console.error('[WebSocketServer] Erro ao enviar última tradução para novo assinante:', sendError);
          }
        }
      }
    } else if (parsedData.action === 'process_speech' && parsedData.sourceLanguage && parsedData.targetLanguage) {
      
      let textToTranslate = parsedData.transcribedText; // Pode ser texto real (microfone) ou placeholder (sistema)
      const currentSourceLanguage = parsedData.sourceLanguage;
      const currentTargetLanguage = parsedData.targetLanguage;
      const audioSourceMode = parsedData.audioSourceMode;
      let transcriptionSource = audioSourceMode === "microphone" ? "Microphone (Client STT)" : "System Audio (Server STT)";
      let sttErrorOccurred = false;

      try {
        // Se for áudio do sistema, o 'transcribedText' recebido é um placeholder.
        // O áudio real está em 'audioDataUri' e precisa ser transcrito.
        if (audioSourceMode === "system" && parsedData.audioDataUri) {
          console.log(`[WebSocketServer] Recebido áudio do sistema com placeholder: "${textToTranslate}". Transcrevendo...`);
          const transcriptionInput: TranscribeAudioInput = {
            audioDataUri: parsedData.audioDataUri,
            languageCode: currentSourceLanguage,
          };
          const transcriptionOutput = await transcribeAudio(transcriptionInput);
          textToTranslate = transcriptionOutput.transcribedText; // Agora textToTranslate é o texto transcrito real
          
          if (!textToTranslate || textToTranslate.startsWith("[Whisper STT Error:") || textToTranslate.startsWith("[Whisper STT: Transcription resulted in empty text")) {
            sttErrorOccurred = true;
          }
        } else if (audioSourceMode === "microphone") {
           // Para áudio do microfone, o 'transcribedText' já é o texto transcrito pelo cliente.
           if (!textToTranslate) {
            console.warn('[WebSocketServer] Modo Microfone, mas texto transcrito está vazio. Não prosseguindo com tradução.');
             if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ originalTextForDebug: "", translationError: 'Texto transcrito do microfone estava vazio. Nenhuma tradução solicitada.' }));
             }
             return;
           }
        }

        if (!textToTranslate || textToTranslate.trim() === "" || sttErrorOccurred) {
            const reason = sttErrorOccurred ? textToTranslate : "Texto vazio ou nulo após STT (se aplicável)";
            console.warn(`[WebSocketServer] Texto para tradução está '${reason}' (fonte: ${transcriptionSource}). Não prosseguindo com tradução.`);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    originalTextForDebug: textToTranslate, // pode ser o erro do STT
                    translationError: `Tradução não solicitada: ${reason}` 
                }));
            }
            return; 
        }
        
        // Lógica de Cache:
        // Se o texto original (real ou placeholder único do cliente) e idiomas são os mesmos,
        // E (para áudio de sistema) o texto transcrito real também é o mesmo (se já tivermos um),
        // então podemos considerar um cache hit.
        // Para simplificar, se for áudio do sistema, e o placeholder for o mesmo, não usaremos o cache
        // para forçar o reprocessamento do áudio, a menos que queiramos implementar hash de áudio.
        // A unicidade do placeholder do cliente (`[System Audio Segment ${Date.now()}]`) já ajuda aqui.

        if (
          lastProcessedInfo &&
          lastProcessedInfo.originalText === textToTranslate && // Comparando com o texto *após* STT do servidor (se aplicável)
          lastProcessedInfo.sourceLanguage === currentSourceLanguage &&
          lastProcessedInfo.targetLanguage === currentTargetLanguage &&
          // Evitar cache agressivo se o "originalText" é apenas um placeholder repetitivo,
          // mas agora o cliente envia placeholders únicos, então essa condição é mais segura.
          !parsedData.transcribedText?.startsWith("[System Audio Segment") // Não usar cache se o texto *original do cliente* era um placeholder de sistema
        ) {
          console.log(`[WebSocketServer] Cache hit para texto transcrito: "${textToTranslate.substring(0,30)}..." e idiomas. Reenviando tradução anterior.`);
          if (ws.readyState === WebSocket.OPEN) { 
            ws.send(JSON.stringify({ translatedText: lastProcessedInfo.translatedText, originalTextForDebug: textToTranslate.substring(0, 100) }));
          }
          // Listeners já devem ter ou receberão ao se inscrever.
          return; 
        }

        console.log(`[WebSocketServer] Preparando para traduzir texto (fonte: ${transcriptionSource}): "${textToTranslate.substring(0,50)}..."`);
        const translationInput: ImproveTranslationAccuracyInput = {
          text: textToTranslate,
          sourceLanguage: currentSourceLanguage,
          targetLanguage: currentTargetLanguage,
        };
        const translationOutput = await improveTranslationAccuracy(translationInput);
        
        // Atualizar cache com o texto *realmente* traduzido
        lastProcessedInfo = {
          originalText: textToTranslate, // O texto que foi efetivamente para tradução
          sourceLanguage: currentSourceLanguage,
          targetLanguage: currentTargetLanguage,
          translatedText: translationOutput.translatedText,
        };

        if (ws.readyState === WebSocket.OPEN) { 
          ws.send(JSON.stringify({ translatedText: translationOutput.translatedText, originalTextForDebug: textToTranslate.substring(0, 100) }));
        }

        if (translationOutput.translatedText) {
          console.log(`[WebSocketServer] Enviando texto traduzido "${translationOutput.translatedText.substring(0,30)}..." para ${audioSubscribers.size} ouvintes.`);
          audioSubscribers.forEach(subscriber => {
            if (subscriber.readyState === WebSocket.OPEN) {
              try {
                subscriber.send(JSON.stringify({ 
                  type: 'translated_text_for_listener', 
                  text: translationOutput.translatedText,
                  targetLanguage: currentTargetLanguage 
                }));
              } catch (sendError) {
                console.error('[WebSocketServer] Erro ao enviar translated_text_for_listener para assinante:', sendError);
              }
            }
          });
        }

      } catch (error: any) {
        console.error('[WebSocketServer] Erro durante o processamento de STT ou Tradução:', error.message || error, error.cause || error.stack);
        let errorMessage = 'Erro interno do servidor ao processar o áudio/texto.';
        if (error.cause && typeof error.cause === 'object' && 'message' in error.cause) {
            errorMessage = `Erro na API GenAI: ${(error.cause as Error).message}`;
        } else if(error.message){
            errorMessage = `Erro na API GenAI: ${error.message}`;
        }
        // Não limpar lastProcessedInfo aqui, pois o erro pode ser da tradução, não do STT.
        // lastProcessedInfo = null; 
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ error: errorMessage, originalTextForDebug: textToTranslate?.substring(0,100) || parsedData.transcribedText?.substring(0,100) || "[Texto original não disponível no erro]" }));
        }
      }
    } else {
      console.log('[WebSocketServer] Mensagem recebida não é uma ação válida ou faltam dados:', parsedData.action);
       if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ error: `Ação '${parsedData.action}' não reconhecida ou dados insuficientes.` }));
        }
    }
  });

  ws.on('close', (code, reason) => {
    const reasonText = reason ? reason.toString('utf8') : 'Nenhuma razão especificada';
    console.log(`[WebSocketServer] Cliente desconectado. Código: ${code}, Razão: "${reasonText}"`);
    if (audioSubscribers.has(ws)) {
      audioSubscribers.delete(ws);
      console.log('[WebSocketServer] Assinante de áudio removido. Total:', audioSubscribers.size);
    }
  });

  ws.on('error', (error: Error) => {
    console.error('[WebSocketServer] Erro na conexão WebSocket individual do cliente:', error.message, error);
  });

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ message: 'Conectado com sucesso ao servidor WebSocket LinguaVox.' }));
      console.log('[WebSocketServer] Mensagem de boas-vindas enviada ao cliente.');
    }
  } catch (sendError) {
    console.error('[WebSocketServer] Erro ao enviar mensagem de boas-vindas:', sendError);
  }
});

wss.on('error', (error: Error) => {
  console.error('[WebSocketServer] Erro no servidor WebSocket geral:', error.message, error);
});

    