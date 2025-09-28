import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import fs from 'fs';

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GOOGLE_API_KEY);

async function clearStaleRecordings(roomId) {
  try {
    const recordingPath = `./recordings/${roomId}`;
    if (fs.existsSync(recordingPath)) {
      const files = fs.readdirSync(recordingPath);
      for (const file of files) {
        fs.unlinkSync(`${recordingPath}/${file}`);
      }
      fs.rmdirSync(recordingPath);
      console.log(`✅ Cleared recordings for room ${roomId}`);
    }
  } catch (error) {
    console.error(`❌ Error clearing recordings for room ${roomId}:`, error);
  }
}

export async function transcribeAndSummarizeCall(audioFiles, roomId) {
  console.log(`🎙️ Starting AI processing for room ${roomId}...`);
  
  const transcriptions = [];
  
  try {
    // Step 1: Transcribe each audio file
    for (const audioFile of audioFiles) {
      console.log(`📝 Transcribing ${audioFile.user}'s audio...`);
      
      try {
        const uploadResponse = await fileManager.uploadFile(audioFile.file, {
          mimeType: 'audio/webm',
          displayName: `${audioFile.user}_${roomId}`
        });
        
        console.log(`✅ Audio uploaded for ${audioFile.user}`);
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        
        const transcriptionResult = await model.generateContent([
          {
            fileData: {
              mimeType: uploadResponse.file.mimeType,
              fileUri: uploadResponse.file.uri
            }
          },
          'Please provide an accurate transcript of this audio recording. Return only the spoken words without any additional commentary or formatting.'
        ]);
        
        const transcript = transcriptionResult.response.text();
        
        transcriptions.push({
          user: audioFile.user,
          email: audioFile.email,
          transcript: transcript
        });
        
        console.log(`✅ ${audioFile.user}: Transcribed ${transcript.length} characters`);
        
        await fileManager.deleteFile(uploadResponse.file.name);
        
      } catch (error) {
        console.error(`❌ Error transcribing ${audioFile.user}'s audio:`, error.message);
        transcriptions.push({
          user: audioFile.user,
          email: audioFile.email,
          transcript: `[Transcription failed for ${audioFile.user}]`
        });
      }
    }
    
    // Step 2: Generate context-aware summary
    console.log('📋 Generating call summary...');
    
    const combinedTranscript = transcriptions.map(t => 
      `${t.user}: ${t.transcript}`
    ).join('\n\n');
    
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const summaryResult = await model.generateContent([
  `Create a brief, personalized summary of this conversation for each participant.

TRANSCRIPTIONS:
${combinedTranscript}

Instructions:
1. Keep the summary under 3 sentences
2. Write from the perspective of each person (use "you" and the other person's name)
3. Focus on what was discussed, not analysis
4. Be conversational and friendly
5. Don't add business formatting or bullet points

Provide a short, natural summary of what happened in the call.`
]);
    
    const summary = summaryResult.response.text();
    console.log('✅ Summary generated successfully');
    
    // Add cleanup at the end
    await clearStaleRecordings(roomId);
    
    return {
      transcriptions,
      summary,
      success: true
    };
    
  } catch (error) {
    console.error('❌ Error in AI processing:', error.message);
    // Still try to cleanup even if processing failed
    await clearStaleRecordings(roomId);
    return {
      transcriptions,
      summary: 'AI processing failed due to an error. Please check the logs.',
      success: false
    };
  }
}
