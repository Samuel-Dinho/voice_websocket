
import { config } from 'dotenv';
config();

import '@/ai/flows/improve-translation-accuracy.ts';
import '@/ai/flows/transcribe-audio-flow.ts'; // Adicionada importação do novo fluxo
// import '@/ai/flows/translate-audio.ts'; // Removido pois não será mais usado para transcrição de áudio

    
