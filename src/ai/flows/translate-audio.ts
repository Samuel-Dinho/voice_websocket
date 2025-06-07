
'use server';
/**
 * @fileOverview Audio transcription flow (translation step removed for debugging).
 *
 * - translateAudio - A function that handles the audio transcription.
 * - TranslateAudioInput - The input type for the translateAudio function.
 * - TranslateAudioOutput - The return type for the translateAudio function (will only contain transcribed text).
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';
import { GoogleGenerativeAIFetchError } from '@google/generative-ai';

const TranslateAudioInputSchema = z.object({
  audioDataUri: z
    .string()
    .describe(
      "The audio data as a data URI that must include a MIME type and use Base64 encoding. Expected format: 'data:<mimetype>;base64,<encoded_data>'."
    ),
  sourceLanguage: z.string().describe('The language of the audio to be transcribed (currently not used in the simplified prompt).'),
});
export type TranslateAudioInput = z.infer<typeof TranslateAudioInputSchema>;

const TranslateAudioOutputSchema = z.object({
  transcribedText: z.string().describe('The transcribed text of the audio.'),
});
export type TranslateAudioOutput = z.infer<typeof TranslateAudioOutputSchema>;


export async function translateAudio(input: TranslateAudioInput): Promise<TranslateAudioOutput> {
  console.log(`[translateAudio Flow Invoked] Input audioDataUri (start): ${input.audioDataUri.substring(0, 100)}...`);
  return translateAudioFlow(input);
}

const translateAudioFlow = ai.defineFlow(
  {
    name: 'translateAudioFlow',
    inputSchema: TranslateAudioInputSchema,
    outputSchema: TranslateAudioOutputSchema,
  },
  async (input: TranslateAudioInput) => {
    console.log(`[translateAudioFlow] Processing input. audioDataUri (start): ${input.audioDataUri.substring(0, 200)}...`);
    
    try {
      // Step 1: Transcribe audio to text with a highly simplified prompt
      console.log(`[translateAudioFlow] Step 1: Attempting to transcribe audio. audioDataUri (start): ${input.audioDataUri.substring(0,60)}...)`);
      
      const transcriptionPromptParts = [
        {text: "Transcribe the following audio. Provide only the transcribed text."}, // Prompt ultra-simplificado
        {media: {url: input.audioDataUri}},
        {text: "Transcription:"}
      ];

      const transcriptionResponse = await ai.generate({
        prompt: transcriptionPromptParts,
        config: { 
          temperature: 0.3,
          safetySettings: [ 
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          ]
        }
      });

      const transcribedText = transcriptionResponse.text?.trim();
      console.log(`[translateAudioFlow] Raw transcription response text: "${transcribedText}"`);

      if (!transcribedText) {
          console.warn('[translateAudioFlow] Transcription step returned no text or empty text. Returning indicative message.');
          return { transcribedText: `[Transcription Error: No text returned for audio chunk]` };
      }

      console.log(`[translateAudioFlow] Transcription successful. Text: "${transcribedText}".`);
      return { transcribedText: transcribedText };

    } catch (error: any) {
        console.error('[translateAudioFlow] Error during ai.generate (transcription):', error.message);
        if (error instanceof GoogleGenerativeAIFetchError || error.constructor.name === 'GoogleGenerativeAIFetchError') {
          console.error('[translateAudioFlow] GoogleGenerativeAIFetchError Details:', {
            status: (error as GoogleGenerativeAIFetchError).status,
            statusText: (error as GoogleGenerativeAIFetchError).statusText,
            message: error.message,
            errorDetails: (error as GoogleGenerativeAIFetchError).errorDetails, 
            traceId: (error as any).traceId 
          });
        } else {
          console.error('[translateAudioFlow] Non-GoogleGenerativeAIFetchError Details:', error);
        }
        throw error; 
    }
  }
);
