
import { WebSocketServer, WebSocket } from 'ws';
import { translateAudio, type TranslateAudioInput } from './ai/flows/translate-audio';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig(); // Carrega variáveis de ambiente do .env

const PORT = parseInt(process.env.WEBSOCKET_PORT || '3001', 10);

const wss = new WebSocketServer({ port: PORT });

console.log(`[WebSocketServer] Iniciado em ws://localhost:${PORT}`);

wss.on('connection', (ws: WebSocket) => {
  console.log('[WebSocketServer] Cliente conectado');

  ws.on('message', async (message: Buffer) => {
    try {
      const dataString = message.toString();
      const parsedData: TranslateAudioInput = JSON.parse(dataString);

      if (!parsedData.audioDataUri || !parsedData.sourceLanguage || !parsedData.targetLanguage) {
        ws.send(JSON.stringify({ error: 'Formato de mensagem inválido. Campos obrigatórios: audioDataUri, sourceLanguage, targetLanguage' }));
        return;
      }
      
      console.log(`[WebSocketServer] Áudio recebido para tradução: ${parsedData.sourceLanguage} para ${parsedData.targetLanguage}. Tamanho dos dados de áudio: ${parsedData.audioDataUri.length}`);

      const translationOutput = await translateAudio(parsedData);
      ws.send(JSON.stringify({ translatedText: translationOutput.translatedText }));
      console.log(`[WebSocketServer] Texto traduzido enviado: "${translationOutput.translatedText}"`);

    } catch (error) {
      console.error('[WebSocketServer] Erro ao processar mensagem ou traduzir:', error);
      let errorMessage = 'Erro ao processar mensagem.';
      if (error instanceof Error) {
          errorMessage = error.message;
      }
      ws.send(JSON.stringify({ error: errorMessage }));
    }
  });

  ws.on('close', () => {
    console.log('[WebSocketServer] Cliente desconectado');
  });

  ws.on('error', (error: Error) => {
    console.error('[WebSocketServer] Erro de conexão:', error);
  });

  ws.send(JSON.stringify({ message: 'Conectado com sucesso ao servidor WebSocket LinguaVox.' }));
});

wss.on('error', (error: Error) => {
  console.error('[WebSocketServer] Erro no servidor:', error);
});
