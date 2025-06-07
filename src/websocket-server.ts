
import { WebSocketServer, WebSocket } from 'ws';
// import { translateAudio, type TranslateAudioInput } from './ai/flows/translate-audio'; // Removido
import { config as dotenvConfig } from 'dotenv';

dotenvConfig(); 

const PORT = parseInt(process.env.WEBSOCKET_PORT || '3001', 10);

const wss = new WebSocketServer({ port: PORT });

console.log(`[WebSocketServer] Iniciado em ws://localhost:${PORT}`);

// A lógica de estado do cliente para buffer de áudio e processamento de IA foi removida/simplificada
// já que a transcrição agora ocorre no cliente.
// Poderíamos reintroduzir um estado se o servidor for fazer tradução do texto recebido.

// const AUDIO_CHUNKS_TO_ACCUMULATE = 3; 
// const INACTIVITY_TIMEOUT_MS = 1500; 
// const PROCESSING_DELAY_MS = 3000; 

// interface ClientState {
//   audioBuffer: Blob[];
//   inactivityTimer: NodeJS.Timeout | null;
//   sourceLanguage: string | null;
//   targetLanguage: string | null; 
//   isProcessing: boolean; 
//   messageQueue: Buffer[]; 
// }
// const clientStates = new Map<WebSocket, ClientState>();

// const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// async function processClientAudio(ws: WebSocket) {
  // ... lógica removida ...
// }


wss.on('connection', (ws: WebSocket) => {
  console.log('[WebSocketServer] Cliente conectado');
  // clientStates.set(ws, { /* ... estado anterior removido ... */ }); // Não é mais necessário para transcrição

  ws.on('message', async (message: Buffer) => {
    // const clientState = clientStates.get(ws); // Não é mais necessário para transcrição
    // if (!clientState) return; 
    
    try {
      const dataString = message.toString();
      let parsedData: { text?: string, sourceLanguage?: string, targetLanguage?: string }; // Exemplo se for receber texto

      try {
        parsedData = JSON.parse(dataString);
      } catch (e) {
        console.warn(`[WebSocketServer] Falha ao parsear JSON: "${dataString.substring(0,100)}..."`, e);
        if (ws.readyState === WebSocket.OPEN) {
         ws.send(JSON.stringify({ error: `Formato de mensagem inválido (não é JSON)` }));
        }
        return;
      }

      // Se o cliente enviar texto transcrito:
      if (parsedData.text) {
        console.log(`[WebSocketServer] Texto transcrito recebido do cliente: "${parsedData.text}"`);
        // Aqui você poderia, por exemplo, enviar para um fluxo de tradução Genkit
        // Ex: const translationOutput = await improveTranslationAccuracy({ text: parsedData.text, sourceLanguage: 'pt', targetLanguage: 'en' });
        // E então enviar a tradução de volta: ws.send(JSON.stringify({ translatedText: translationOutput.translatedText }));
        // Por agora, apenas logamos.
        if (ws.readyState === WebSocket.OPEN) {
          // Exemplo de eco, ou poderia ser uma tradução
          // ws.send(JSON.stringify({ message: `Servidor recebeu: ${parsedData.text}`})); 
        }
      } else {
        console.log(`[WebSocketServer] Mensagem recebida do cliente (não é texto de transcrição): ${dataString.substring(0,100)}`);
      }


    } catch (error: any) {
      console.error('[WebSocketServer] Erro no manipulador de mensagens:', error.message || error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: `Erro do servidor ao processar sua mensagem.` }));
      }
    }
  });

  ws.on('close', (code, reason) => {
    const reasonText = reason ? reason.toString('utf8') : 'Nenhuma razão especificada';
    console.log(`[WebSocketServer] Cliente desconectado. Código: ${code}, Razão: "${reasonText}"`);
    // const clientState = clientStates.get(ws); // Limpeza de estado anterior
    // if (clientState && clientState.inactivityTimer) {
    //   clearTimeout(clientState.inactivityTimer);
    // }
    // clientStates.delete(ws);
  });

  ws.on('error', (error: Error) => {
    console.error('[WebSocketServer] Erro na conexão WebSocket individual do cliente:', error.message, error);
    // const clientState = clientStates.get(ws);
    // if(clientState) clientState.isProcessing = false; 
  });

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ message: 'Conectado com sucesso ao servidor WebSocket LinguaVox (modo transcrição no cliente).' }));
      console.log('[WebSocketServer] Mensagem de boas-vindas (modo transcrição no cliente) enviada ao cliente.');
    }
  } catch (sendError) {
    console.error('[WebSocketServer] Erro ao enviar mensagem de boas-vindas:', sendError);
  }
});

wss.on('error', (error: Error) => {
  console.error('[WebSocketServer] Erro no servidor WebSocket geral:', error.message, error);
});

    