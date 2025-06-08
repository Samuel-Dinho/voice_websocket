
'use server';
/**
 * @fileOverview This file defines a Genkit flow for transcribing audio.
 * It attempts to use the configured Genkit model for transcription.
 * For accurate and robust transcription, ensure the Genkit AI model
 * configured in src/ai/genkit.ts is multimodal (e.g., Gemini 1.5 Flash/Pro)
 * and your API key has the necessary permissions.
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
  languageCode: z.string().optional().describe('The language of the audio. BCP-47 format (e.g., "en-US", "pt-BR"). This will be a hint for the model.'),
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
  console.log(`[transcribeAudioFlow] Attempting STT: Received input. Language: ${input.languageCode || 'not specified'}, Audio URI (first 60 chars): ${input.audioDataUri.substring(0, 60)}`);
  try {
    const result = await transcribeAudioFlow(input);
    console.log(`[transcribeAudioFlow] STT Attempt: Flow executed. Result: "${result.transcribedText.substring(0,100)}..."`);
    if (!result.transcribedText || result.transcribedText.trim() === "") {
        console.warn("[transcribeAudioFlow] STT Attempt: Transcription result was empty.");
        return { transcribedText: `[Transcrição resultou em texto vazio para ${input.languageCode || 'áudio fornecido'}]` };
    }
    return result;
  } catch (error: any) {
    console.error('[transcribeAudioFlow] STT Attempt: Error executing flow:', error.message || error, error.cause || error.stack);
    const errorMessage = error.cause?.message || error.message || 'Erro desconhecido na transcrição';
    return { transcribedText: `[Transcrição falhou: ${errorMessage}]` };
  }
}

const transcribeAudioPrompt = ai.definePrompt({
    name: 'transcribeAudioPrompt',
    input: { schema: TranscribeAudioInputSchema },
    output: { schema: TranscribeAudioOutputSchema },
    // IMPORTANT: For this to work, the model configured in src/ai/genkit.ts
    // (e.g., gemini-2.0-flash, or ideally a more capable multimodal model like gemini-1.5-flash)
    // must be able to process audio data passed via {{media url=...}}.
    // Provide a clear instruction to transcribe.
    prompt: `Your task is to transcribe the audio provided.
The primary language of the audio is expected to be '{{languageCode}}'.
If the audio is silent or unintelligible, respond with an empty string or a very brief note like "[silence]" or "[unintelligible]".
Provide only the transcribed text.

Audio for transcription:
{{media url=audioDataUri}}
`,
});


const transcribeAudioFlow = ai.defineFlow(
  {
    name: 'transcribeAudioFlow',
    inputSchema: TranscribeAudioInputSchema,
    outputSchema: TranscribeAudioOutputSchema,
  },
  async (input: TranscribeAudioInput) => {
    console.log(`[transcribeAudioFlow - flow execution] Attempting to transcribe for language: ${input.languageCode || 'not specified'}`);
    
    // Default to a placeholder if the model fails or returns nothing.
    let outputText = `[Transcrição não disponível ou falhou para ${input.languageCode || 'áudio'}]`;

    try {
        const {output} = await transcribeAudioPrompt(input);
        if (output && typeof output.transcribedText === 'string') {
            outputText = output.transcribedText;
             console.log(`[transcribeAudioFlow - flow execution] STT Model successful. Transcribed text (first 100 chars): "${outputText.substring(0,100)}"`);
        } else {
            console.warn(`[transcribeAudioFlow - flow execution] STT Model output was null, undefined, or not a string. Output:`, output);
            outputText = `[Formato de saída inesperado do modelo STT para ${input.languageCode || 'áudio'}]`;
        }
    } catch (e: any) {
        console.error(`[transcribeAudioFlow - flow execution] Error calling transcribeAudioPrompt:`, e.message || e, e.cause || e.stack);
        const errorMessage = e.cause?.message || e.message || 'Erro desconhecido ao chamar o prompt de transcrição';
        outputText = `[Erro ao chamar o prompt de transcrição: ${errorMessage}]`;
    }
    return { transcribedText: outputText };
  }
);

// Export ai and z for use in other flows if necessary
export {ai as genkitAI, z as zod};
