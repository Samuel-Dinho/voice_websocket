
'use server';
/**
 * @fileOverview This file defines a Genkit flow for transcribing audio.
 * NOTE: THIS IS A PLACEHOLDER. The current Gemini model (e.g., `gemini-2.0-flash`)
 * is NOT a dedicated Speech-to-Text (STT) model.
 * Attempting to pass audio data directly to it for transcription
 * can lead to "Invalid Argument" errors from the API.
 *
 * For accurate and robust transcription, a dedicated STT model/service
 * (e.g., Google Cloud Speech-to-Text integrated via Genkit) will be necessary.
 * This flow currently returns a placeholder text indicating this need.
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
      "The audio data to be transcribed, as a data URI. Expected format: 'data:<mimetype>;base64,<encoded_data>'. NOTE: This URI is currently NOT directly processed by the LLM in this placeholder flow to avoid API errors."
    ),
  languageCode: z.string().optional().describe('The language of the audio. BCP-47 format (e.g., "en-US", "pt-BR"). Optional, model may auto-detect.'),
});

export type TranscribeAudioInput = z.infer<typeof TranscribeAudioInputSchema>;

const TranscribeAudioOutputSchema = z.object({
  transcribedText: z.string().describe('The transcribed text from the audio. Currently a placeholder.'),
});

export type TranscribeAudioOutput = z.infer<
  typeof TranscribeAudioOutputSchema
>;

export async function transcribeAudio(
  input: TranscribeAudioInput
): Promise<TranscribeAudioOutput> {
  // Log que o áudio foi recebido, mas não será passado diretamente ao prompt problemático.
  console.log('[transcribeAudioFlow] Placeholder STT: Received input. Language:', input.languageCode, 'Audio URI (first 60 chars):', input.audioDataUri.substring(0, 60));
  try {
    // Passamos apenas languageCode para o flow que chama o prompt,
    // já que o prompt não usará o audioDataUri para evitar erros.
    const result = await transcribeAudioFlow({ languageCode: input.languageCode });
    console.log('[transcribeAudioFlow] Placeholder STT: Flow executed. Result:', result?.transcribedText?.substring(0,100) || "No text or error");
    return result;
  } catch (error: any) {
    console.error('[transcribeAudioFlow] Placeholder STT: Error executing flow:', error.message || error, error.cause || error.stack);
    // Se houver erro na chamada do fluxo (ex: modelo não encontrado), retorne o placeholder
    return { transcribedText: `[Erro na execução do fluxo de transcrição placeholder: ${error.message || 'Erro desconhecido'}]` };
  }
}

// O 'model' explícito foi removido para usar o padrão de genkit.ts
// O prompt foi alterado para NÃO usar {{media url=audioDataUri}}
const transcribeAudioPrompt = ai.definePrompt({
  name: 'transcribeAudioPrompt',
  input: {
    schema: z.object({ // O prompt agora espera apenas languageCode
        languageCode: z.string().optional().describe('The language of the audio.'),
    })
  },
  output: {
    schema: TranscribeAudioOutputSchema,
  },
  // Este prompt agora só usa languageCode e age como um placeholder.
  prompt: `You are a helpful assistant. The user wants to transcribe audio.
The audio language is '{{{languageCode}}}'.
Since direct audio processing by you is not set up for STT, provide a placeholder text acknowledging the transcription request for this language and stating that a dedicated STT model is needed.
For example, for 'en-US', respond with: "[Placeholder transcription for en-US audio. Dedicated STT model required for actual transcription.]"
If languageCode is not provided, use a generic placeholder like: "[Placeholder transcription. Dedicated STT model required.]"
Return ONLY the placeholder text in the 'transcribedText' field.`,
});

const transcribeAudioFlow = ai.defineFlow(
  {
    name: 'transcribeAudioFlow',
    inputSchema: z.object({ // O fluxo em si agora espera apenas languageCode
        languageCode: z.string().optional(),
    }),
    outputSchema: TranscribeAudioOutputSchema,
  },
  async (input: { languageCode?: string }) => { // O tipo do input do fluxo reflete a mudança
    console.log(`[transcribeAudioFlow - flow execution] Placeholder STT: Attempting for language: ${input.languageCode || 'not specified'}`);
    try {
      const {output} = await transcribeAudioPrompt({ languageCode: input.languageCode });

      if (!output || typeof output.transcribedText !== 'string' || output.transcribedText.trim() === "") {
          console.warn('[transcribeAudioFlow - flow execution] Placeholder STT: Output was empty or invalid from the model.');
          // Mesmo se o modelo retornar vazio (ex: silêncio), vamos retornar isso em vez do placeholder de erro,
          // a menos que seja uma falha catastrófica.
          return { transcribedText: output?.transcribedText || "[Placeholder STT output was empty]" };
      }
      console.log('[transcribeAudioFlow - flow execution] Placeholder STT: Successful: "', output.transcribedText.substring(0, 100),'..."');
      return output;
    } catch (error: any) {
        console.error('[transcribeAudioFlow - flow execution] Placeholder STT: Error during prompt execution:', error.message || error, error.cause);
        const errorMessage = error.cause?.message || error.message || "Unknown error during placeholder transcription prompt";
        // Se o erro for de "invalid argument" ou similar, pode ser que o modelo não suporte o formato/conteúdo do áudio.
        if (errorMessage.toLowerCase().includes("invalid argument") || errorMessage.toLowerCase().includes("bad request")) {
            return { transcribedText: `[Transcrição (placeholder) falhou: Argumento inválido para o modelo - ${errorMessage}]` };
        }
        return { transcribedText: `[Erro interno na transcrição (placeholder): ${errorMessage}]` };
    }
  }
);

// Export ai and z for use in other flows if necessary
export {ai as genkitAI, z as zod};
