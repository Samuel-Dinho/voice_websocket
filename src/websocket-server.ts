
'use server';
import { WebSocketServer, WebSocket } from 'ws';
import { config as dotenvConfig } from 'dotenv';
import { improveTranslationAccuracy, type ImproveTranslationAccuracyInput } from './ai/flows/improve-translation-accuracy';
import { transcribeAudio, type TranscribeAudioInput } from './ai/flows/transcribe-audio-flow'; // Import the new flow

dotenvConfig(); 

const PORT = parseInt(process.env.NEXT_PUBLIC_WEBSOCKET_PORT || process.env.WEBSOCKET_PORT || '3001', 10);

const wss = new WebSocketServer({ port: PORT });

console.log(`[WebSocketServer] Iniciado em ws://localhost:${PORT}`);

const audioSubscribers = new Set<WebSocket>();

wss.on('connection', (ws: WebSocket) => {
  console.log('[WebSocketServer] Cliente conectado');

  ws.on('message', async (message: Buffer) => {
    let parsedData: any;
    try {
      const dataString = message.toString();
      parsedData = JSON.parse(dataString);
      console.log('[WebSocketServer] Mensagem recebida do cliente:', parsedData.action, 'Modo Áudio:', parsedData.audioSourceMode);
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
    } else if (parsedData.action === 'process_speech' && parsedData.sourceLanguage && parsedData.targetLanguage) {
      // Required fields: transcribedText (can be placeholder for system audio), sourceLanguage, targetLanguage, audioDataUri (can be null for mic only text)
      // audioSourceMode is also expected

      let textToTranslate = parsedData.transcribedText;

      console.log(`[WebSocketServer] Requisição de process_speech recebida. Texto original (ou placeholder): "${textToTranslate ? textToTranslate.substring(0,30) : 'N/A'}..."`);
      
      try {
        if (parsedData.audioSourceMode === "system" && parsedData.audioDataUri) {
          console.log('[WebSocketServer] Modo Sistema: Tentando transcrever áudio da tela/aba.');
          const transcriptionInput: TranscribeAudioInput = {
            audioDataUri: parsedData.audioDataUri,
            languageCode: parsedData.sourceLanguage, // Pass source language as a hint
          };
          const transcriptionOutput = await transcribeAudio(transcriptionInput);
          textToTranslate = transcriptionOutput.transcribedText;
          console.log(`[WebSocketServer] Texto transcrito (do áudio da tela/aba): "${textToTranslate ? textToTranslate.substring(0,30) : 'Falha na transcrição'}"`);
        } else if (!textToTranslate && parsedData.audioSourceMode === "microphone") {
           console.warn('[WebSocketServer] Modo Microfone, mas texto transcrito está vazio. Não prosseguindo com tradução.');
           if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ error: 'Texto transcrito do microfone estava vazio.' }));
           }
           return;
        }


        if (!textToTranslate || textToTranslate.trim() === "") {
            console.warn('[WebSocketServer] Texto para tradução está vazio ou nulo após tentativa de transcrição (se aplicável). Não prosseguindo.');
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ error: 'Nenhum texto para traduzir após processamento inicial.' }));
            }
            return;
        }

        const translationInput: ImproveTranslationAccuracyInput = {
          text: textToTranslate,
          sourceLanguage: parsedData.sourceLanguage,
          targetLanguage: parsedData.targetLanguage,
        };
        const translationOutput = await improveTranslationAccuracy(translationInput);
        
        if (ws.readyState === WebSocket.OPEN) { 
          ws.send(JSON.stringify({ translatedText: translationOutput.translatedText }));
          console.log(`[WebSocketServer] Tradução enviada para o cliente original: "${translationOutput.translatedText.substring(0,30)}..."`);
        }

        if (translationOutput.translatedText) {
          console.log(`[WebSocketServer] Enviando texto traduzido "${translationOutput.translatedText.substring(0,30)}..." para ${audioSubscribers.size} ouvintes.`);
          audioSubscribers.forEach(subscriber => {
            if (subscriber.readyState === WebSocket.OPEN) {
              try {
                subscriber.send(JSON.stringify({ 
                  type: 'translated_text_for_listener', 
                  text: translationOutput.translatedText,
                  targetLanguage: parsedData.targetLanguage 
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
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ error: errorMessage }));
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
    
