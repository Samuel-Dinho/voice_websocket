
'use server';
import { WebSocketServer, WebSocket } from 'ws';
import { config as dotenvConfig } from 'dotenv';
import { improveTranslationAccuracy, type ImproveTranslationAccuracyInput } from './ai/flows/improve-translation-accuracy';

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
      console.log('[WebSocketServer] Mensagem recebida do cliente:', parsedData.action);
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
    } else if (parsedData.action === 'process_speech' && parsedData.transcribedText && parsedData.sourceLanguage && parsedData.targetLanguage && parsedData.audioDataUri) {
      console.log(`[WebSocketServer] Requisição de process_speech recebida. Texto: "${parsedData.transcribedText.substring(0,30)}..."`);
      
      // Process translation
      try {
        const translationInput: ImproveTranslationAccuracyInput = {
          text: parsedData.transcribedText,
          sourceLanguage: parsedData.sourceLanguage,
          targetLanguage: parsedData.targetLanguage,
        };
        const translationOutput = await improveTranslationAccuracy(translationInput);
        
        // Send translation back to original sender
        if (ws.readyState === WebSocket.OPEN) { 
          ws.send(JSON.stringify({ translatedText: translationOutput.translatedText }));
          console.log(`[WebSocketServer] Tradução enviada para o cliente original: "${translationOutput.translatedText.substring(0,30)}..."`);
        }

        // Send translated text to audio subscribers for speech synthesis
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
        console.error('[WebSocketServer] Erro ao chamar o fluxo de tradução:', error.message || error);
        let errorMessage = 'Erro interno do servidor ao traduzir.';
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
    