import 'dotenv/config';
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import multer from "multer";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { transcribeAndSummarizeCall } from './audioProcessor.js';
import { sendCallSummary } from './emailService.js';

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(express.static("public"));

["index", "start-call", "join-room", "call-room"].forEach(page =>
  app.get(page === "index" ? "/" : `/${page}.html`,
    (req, res) => res.sendFile(join(__dirname, "app", `${page}.html`)))
);

const roomUsers = {};

io.on("connection", socket => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("join-room", ({ roomId, userName, email }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const numClients = room ? room.size : 0;

    if (numClients >= 2) {
      socket.emit("room-full");
      return;
    }

    socket.join(roomId);
    console.log(`${userName} joined room ${roomId}`);

    if (!roomUsers[roomId]) roomUsers[roomId] = [];
    roomUsers[roomId].push({ socketId: socket.id, userName, email });

    io.to(roomId).emit("room-users-updated", roomUsers[roomId]);

    socket.to(roomId).emit("user-joined", {
      userName: userName,
      socketId: socket.id
    });

    socket.on("offer", data => {
      socket.to(roomId).emit("offer", data);
    });

    socket.on("answer", data => {
      socket.to(roomId).emit("answer", data);
    });

    socket.on("ice-candidate", data => {
      socket.to(roomId).emit("ice-candidate", data);
    });

    socket.on("end-call", ({ roomId }) => {
      console.log(`Call ended in room ${roomId} by ${userName}`);
      
      io.to(roomId).emit("call-ended");
      socket.to(roomId).emit("user-left", { userName, socketId: socket.id });
      
      setTimeout(() => {
        io.to(roomId).emit("call-ended");
      }, 3000);
    });

    socket.on("toggle-mic", ({ roomId, userName, micEnabled }) => {
      socket.to(roomId).emit("remote-mic-toggled", { userName, micEnabled });
    });

    socket.on("toggle-camera", ({ roomId, userName, camEnabled }) => {
      socket.to(roomId).emit("remote-camera-toggled", { userName, camEnabled });
    });

    socket.on("disconnect", () => {
      console.log(`${userName} disconnected from room ${roomId}`);
      
      socket.to(roomId).emit("user-left", { userName, socketId: socket.id });
      socket.to(roomId).emit("call-ended");
      
      if (roomUsers[roomId]) {
        roomUsers[roomId] = roomUsers[roomId].filter(user => user.socketId !== socket.id);
        
        if (roomUsers[roomId].length === 0) {
          setTimeout(() => {
            if (roomUsers[roomId] && roomUsers[roomId].length === 0) {
              delete roomUsers[roomId];
              
              if (callRecordings[roomId] && callRecordings[roomId].participants.size < 2) {
                console.log(`Clearing stale recordings for room ${roomId}`);
                callRecordings[roomId].audioFiles.forEach(f => {
                  try { 
                    fs.unlinkSync(f.file); 
                  } catch (err) {}
                });
                delete callRecordings[roomId];
              }
            }
          }, 5000);
        } else {
          io.to(roomId).emit("room-users-updated", roomUsers[roomId]);
        }
      }
    });
  });
});

const storage = multer.diskStorage({
  destination: "recordings/",
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

const callRecordings = {};

app.post("/upload-audio", upload.single("audio"), (req, res) => {
  const { roomId, userName, email } = req.body;

  if (!callRecordings[roomId]) {
    callRecordings[roomId] = { audioFiles: [], participants: new Set() };
    console.log(`Recording started for room ${roomId}`);
  }

  callRecordings[roomId].audioFiles.push({ 
    user: userName, 
    email: email,
    file: req.file.path 
  });
  callRecordings[roomId].participants.add(userName);

  console.log(`Audio of ${userName} recorded (${callRecordings[roomId].participants.size}/2)`);

  if (callRecordings[roomId].participants.size === 2) {
    console.log(`Both users audio recorded, processing call...`);
    processCall(roomId);
  }

  res.json({ status: "ok" });
});

// Check email credentials only when needed (post-call)
function checkEmailCredentials() {
  const hasEmailUser = process.env.EMAIL_USER && process.env.EMAIL_USER.trim() !== '';
  const hasEmailPass = process.env.EMAIL_PASS && process.env.EMAIL_PASS.trim() !== '';
  return hasEmailUser && hasEmailPass;
}

async function processCall(roomId) {
  try {
    const result = await transcribeAndSummarizeCall(callRecordings[roomId].audioFiles, roomId);
    
    if (result.success) {
      const isBusinessCall = result.summary.toLowerCase().includes('decision') || 
                             result.summary.toLowerCase().includes('meeting') ||
                             result.summary.toLowerCase().includes('professional') ||
                             result.summary.toLowerCase().includes('business') ||
                             result.summary.toLowerCase().includes('project');
      
      console.log(`\n📋 ${isBusinessCall ? 'PROFESSIONAL' : 'PERSONAL'} CALL SUMMARY:`);
      console.log('─'.repeat(50));
      console.log(result.summary);
      console.log('─'.repeat(50));

      // Check email credentials ONLY after call processing
      let emailsSent = false;
      
      if (checkEmailCredentials()) {
        console.log('\n📤 Sending personalized emails...');
        
        const callDetails = {
          roomId,
          callDate: new Date().toISOString()
        };

        try {
          for (const transcription of result.transcriptions) {
            const participant = {
              user: transcription.user,
              email: transcription.email
            };
            
            const emailSent = await sendCallSummary(participant, result.summary, callDetails);
            if (emailSent) {
              emailsSent = true;
            } else {
              console.log(`⚠️ Email delivery failed for ${participant.user}`);
            }
          }
          
          if (emailsSent) {
            console.log('✅ Email summaries sent successfully!');
          }
        } catch (emailError) {
          console.error('❌ Email service error:', emailError.message);
          console.log('📧 Email summaries could not be sent');
        }
      } else {
        console.log('\n📧 Email credentials not provided - skipping email delivery');
        console.log('💡 To enable emails, add EMAIL_USER and EMAIL_PASS to your .env file');
      }
      
      // Send to n8n webhook if configured
      if (process.env.N8N_WEBHOOK_URL) {
        const payload = {
          roomId,
          callDate: new Date().toISOString(),
          transcriptions: result.transcriptions,
          summary: result.summary,
          participants: [...callRecordings[roomId].participants],
          emailsSent: emailsSent,
          emailCredentialsProvided: checkEmailCredentials()
        };
        
        await fetch(process.env.N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        console.log('\n📤 Results also sent to n8n webhook');
      }
      
    } else {
      console.log('⚠️ AI processing failed, trying n8n fallback...');
      
      if (process.env.N8N_WEBHOOK_URL) {
        const payload = {
          roomId,
          callDate: new Date().toISOString(),
          audioFiles: callRecordings[roomId].audioFiles
                     .map(f => ({ 
                       user: f.user, 
                       email: f.email,
                       fileName: path.basename(f.file) 
                     })),
          participants: [...callRecordings[roomId].participants],
          emailsSent: false,
          emailCredentialsProvided: checkEmailCredentials(),
          aiProcessingFailed: true
        };
        
        await fetch(process.env.N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        console.log('📤 Sent to n8n successfully (fallback)');
      }
    }
    
    callRecordings[roomId].audioFiles.forEach(f => {
      try {
        fs.unlinkSync(f.file);
      } catch (err) {
        console.log(`🗑️ File already deleted: ${f.file}`);
      }
    });
    
    delete callRecordings[roomId];
    console.log('\n✅ Call processing completed!\n');
    
  } catch (error) {
    console.error('❌ Error processing call:', error.message);
    
    try {
      if (process.env.N8N_WEBHOOK_URL) {
        const payload = {
          roomId,
          callDate: new Date().toISOString(),
          audioFiles: callRecordings[roomId].audioFiles
                     .map(f => ({ 
                       user: f.user, 
                       email: f.email,
                       fileName: path.basename(f.file) 
                     })),
          participants: [...callRecordings[roomId].participants],
          error: 'AI processing failed',
          emailCredentialsProvided: checkEmailCredentials()
        };
        
        await fetch(process.env.N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        console.log('📤 Error details sent to n8n');
      }
    } catch {}
    
    callRecordings[roomId].audioFiles.forEach(f => {
      try { fs.unlinkSync(f.file); } catch {}
    });
    delete callRecordings[roomId];
  }
}

server.listen(9000, '0.0.0.0', () => {
  console.log("Server running on http://localhost:9000");
  
  // Simple startup message - no email config check here
  console.log('\n🔧 AI Transcription Service Ready');
 
});
