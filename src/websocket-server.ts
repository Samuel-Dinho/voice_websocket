
'use server';
import { WebSocketServer, WebSocket } from 'ws';
import { config as dotenvConfig } from 'dotenv';
import { improveTranslationAccuracy, type ImproveTranslationAccuracyInput } from './ai/flows/improve-translation-accuracy';

dotenvConfig(); 

const PORT = parseInt(process.env.NEXT_PUBLIC_WEBSOCKET_PORT || process.env.WEBSOCKET_PORT || '3001', 10);

const wss = new WebSocketServer({ port: PORT });

console.log(`[WebSocketServer] Iniciado em ws://localhost:${PORT}`);

wss.on('connection', (ws: WebSocket) => {
  console.log('[WebSocketServer] Cliente conectado');

  ws.on('message', async (message: Buffer) => {
    let parsedData: any;
    try {
      const dataString = message.toString();
      parsedData = JSON.parse(dataString);
      console.log('[WebSocketServer] Mensagem recebida do cliente:', parsedData);
    } catch (e) {
      console.warn(`[WebSocketServer] Falha ao parsear JSON: "${message.toString().substring(0,100)}..."`, e);
      if (ws.readyState === WebSocket.OPEN) {
       ws.send(JSON.stringify({ error: `Formato de mensagem inválido (não é JSON)` }));
      }
      return;
    }

    if (parsedData.action === 'translate' && parsedData.text && parsedData.sourceLanguage && parsedData.targetLanguage) {
      console.log(`[WebSocketServer] Requisição de tradução recebida. Texto: "${parsedData.text}", De: ${parsedData.sourceLanguage}, Para: ${parsedData.targetLanguage}`);
      try {
        const translationInput: ImproveTranslationAccuracyInput = {
          text: parsedData.text,
          sourceLanguage: parsedData.sourceLanguage,
          targetLanguage: parsedData.targetLanguage,
        };
        const translationOutput = await improveTranslationAccuracy(translationInput);
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ translatedText: translationOutput.translatedText }));
          console.log(`[WebSocketServer] Tradução enviada para o cliente: "${translationOutput.translatedText}"`);
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
      console.log('[WebSocketServer] Mensagem recebida não é uma ação de tradução válida:', parsedData);
    }
  });

  ws.on('close', (code, reason) => {
    const reasonText = reason ? reason.toString('utf8') : 'Nenhuma razão especificada';
    console.log(`[WebSocketServer] Cliente desconectado. Código: ${code}, Razão: "${reasonText}"`);
  });

  ws.on('error', (error: Error) => {
    console.error('[WebSocketServer] Erro na conexão WebSocket individual do cliente:', error.message, error);
  });

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ message: 'Conectado com sucesso ao servidor WebSocket LinguaVox para tradução.' }));
      console.log('[WebSocketServer] Mensagem de boas-vindas (tradução) enviada ao cliente.');
    }
  } catch (sendError) {
    console.error('[WebSocketServer] Erro ao enviar mensagem de boas-vindas:', sendError);
  }
});

wss.on('error', (error: Error) => {
  console.error('[WebSocketServer] Erro no servidor WebSocket geral:', error.message, error);
});

    