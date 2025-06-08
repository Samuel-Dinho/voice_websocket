
'use server';
/**
 * @fileOverview This file defines a Genkit flow for transcribing audio.
 * NOTE: This flow attempts to use Gemini 1.5 Flash for transcription.
 * If this model is not available or transcription quality is poor,
 * a dedicated STT model/service (e.g., Google Cloud Speech-to-Text integrated via Genkit)
 * will be necessary for accurate and robust transcription.
 *
 * - transcribeAudio - A function that initiates the audio transcription flow.
 * - TranscribeAudioInput - The input type for the transcribeAudio function.
 * - TranscribeAudioOutput - The return type for the transcribeAudio function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const TranscribeAudioInputSchema = z.object({
  audioDataUri: z
    .string()
    .describe(
      "The audio data to be transcribed, as a data URI. Expected format: 'data:<mimetype>;base64,<encoded_data>'."
    ),
  languageCode: z.string().optional().describe('The language of the audio. BCP-47 format (e.g., "en-US", "pt-BR"). Optional, model may auto-detect.'),
});

export type TranscribeAudioInput = z.infer<typeof TranscribeAudioInputSchema>;

const TranscribeAudioOutputSchema = z.object({
  transcribedText: z.string().describe('The transcribed text from the audio.'),
});

export type TranscribeAudioOutput = z.infer<
  typeof TranscribeAudioOutputSchema
>;

export async function transcribeAudio(
  input: TranscribeAudioInput
): Promise<TranscribeAudioOutput> {
  console.log('[transcribeAudioFlow] Received input for transcription. Language:', input.languageCode, 'Audio URI (first 100 chars):', input.audioDataUri.substring(0, 100));
  try {
    const result = await transcribeAudioFlow(input);
    console.log('[transcribeAudioFlow] Transcription flow executed. Result:', result?.transcribedText?.substring(0,100) || "No text or error");
    return result;
  } catch (error: any) {
    console.error('[transcribeAudioFlow] Error executing transcription flow:', error.message || error, error.cause || error.stack);
    // Se houver erro na chamada do fluxo (ex: modelo não encontrado), retorne o placeholder
    return { transcribedText: "[Erro na transcrição no servidor - verificar logs do servidor]" };
  }
}

// Attempt to use a more recent Gemini model that has better multimodal capabilities.
// If 'gemini-1.5-flash-latest' is not recognized by the Genkit GoogleAI plugin version,
// Genkit might throw an error on startup, or this flow might fail.
// In such a case, remove the 'model' line to default to the globally configured model.
const transcribeAudioPrompt = ai.definePrompt({
  name: 'transcribeAudioPrompt',
  model: 'googleai/gemini-1.5-flash-latest', // Attempt to use Gemini 1.5 Flash
  input: {
    schema: TranscribeAudioInputSchema,
  },
  output: {
    schema: TranscribeAudioOutputSchema,
  },
  prompt: `You are a highly accurate Speech-to-Text engine.
Your task is to transcribe the provided audio into text.
The audio language is likely '{{{languageCode}}}', but if the audio clearly dictates another language, prioritize the actual spoken language.
Audio to transcribe: {{media url=audioDataUri}}

Return ONLY the transcribed text. Do not add any commentary, preamble, or extra formatting.
If the audio is silent or contains no discernible speech, return an empty string for the transcribedText.`,
});

const transcribeAudioFlow = ai.defineFlow(
  {
    name: 'transcribeAudioFlow',
    inputSchema: TranscribeAudioInputSchema,
    outputSchema: TranscribeAudioOutputSchema,
  },
  async (input: TranscribeAudioInput) => {
    console.log(`[transcribeAudioFlow - flow execution] Attempting transcription with model. Input language: ${input.languageCode}`);
    try {
      const {output} = await transcribeAudioPrompt(input);

      if (!output || typeof output.transcribedText !== 'string' || output.transcribedText.trim() === "") {
          console.warn('[transcribeAudioFlow - flow execution] Transcription output was empty or invalid from the model.');
          // Mesmo se o modelo retornar vazio (ex: silêncio), vamos retornar isso em vez do placeholder de erro,
          // a menos que seja uma falha catastrófica.
          return { transcribedText: output?.transcribedText || "" };
      }
      console.log('[transcribeAudioFlow - flow execution] Transcription successful (first 100 chars): "', output.transcribedText.substring(0, 100),'..."');
      return output;
    } catch (error: any) {
        console.error('[transcribeAudioFlow - flow execution] Error during prompt execution:', error.message || error, error.cause);
        const errorMessage = error.cause?.message || error.message || "Unknown error during transcription prompt";
        // Se o erro for de "invalid argument" ou similar, pode ser que o modelo não suporte o formato/conteúdo do áudio.
        if (errorMessage.toLowerCase().includes("invalid argument") || errorMessage.toLowerCase().includes("bad request")) {
            return { transcribedText: `[Transcrição falhou: Argumento inválido para o modelo - ${errorMessage}]` };
        }
        return { transcribedText: `[Erro interno na transcrição: ${errorMessage}]` };
    }
  }
);

// Export ai and z for use in other flows if necessary
export {ai as genkitAI, z as zod};

    