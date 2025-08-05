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

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ──────────────────────────────────────────────────────
   Static files & HTML routes
─────────────────────────────────────────────────────── */
app.use(express.static("public"));

["index", "start-call", "join-room", "call-room"].forEach(page =>
  app.get(page === "index" ? "/" : `/${page}.html`,
    (req, res) => res.sendFile(join(__dirname, "app", `${page}.html`)))
);

/* ──────────────────────────────────────────────────────
   Socket-IO: rooms & names
─────────────────────────────────────────────────────── */
const roomUsers = {};           // roomId → [{ socketId, userName }]

io.on("connection", socket => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("join-room", ({ roomId, userName }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const numClients = room ? room.size : 0;

    if (numClients >= 2) {
      socket.emit("room-full");
      return;
    }

    socket.join(roomId);
    console.log(`${userName} joined room ${roomId}`);

    if (!roomUsers[roomId]) roomUsers[roomId] = [];
    roomUsers[roomId].push({ socketId: socket.id, userName });

    // Send updated user list to all users in room
    io.to(roomId).emit("room-users-updated", roomUsers[roomId]);

    // Notify other users that someone joined
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
      console.log(`Call ended in room ${roomId}`);
      io.to(roomId).emit("call-ended");
    });

    socket.on("toggle-mic", ({ roomId, userName, micEnabled }) => {
      socket.to(roomId).emit("remote-mic-toggled", { userName, micEnabled });
    });

    socket.on("toggle-camera", ({ roomId, userName, camEnabled }) => {
      socket.to(roomId).emit("remote-camera-toggled", { userName, camEnabled });
    });

    socket.on("disconnect", () => {
      console.log(`Socket disconnected: ${socket.id}`);
      
      // Remove user from room users
      if (roomUsers[roomId]) {
        roomUsers[roomId] = roomUsers[roomId].filter(user => user.socketId !== socket.id);
        
        // If room is empty, delete it
        if (roomUsers[roomId].length === 0) {
          delete roomUsers[roomId];
          
          // 🔴 NEW - Clear any stale recording session
          if (callRecordings[roomId]) {
            console.log(`Clearing stale recordings for room ${roomId}`);
            callRecordings[roomId].audioFiles.forEach(f => {
              try { 
                fs.unlinkSync(f.file); 
              } catch (err) {
                // File might already be deleted, ignore error
              }
            });
            delete callRecordings[roomId];
          }
        } else {
          // Update remaining users
          io.to(roomId).emit("room-users-updated", roomUsers[roomId]);
        }
      }
      
      socket.to(roomId).emit("call-ended");
    });
  });
});

/* ──────────────────────────────────────────────────────
   Audio-file upload endpoint
─────────────────────────────────────────────────────── */
const storage = multer.diskStorage({
  destination: "recordings/",
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

const callRecordings = {};    // roomId → { audioFiles: [{ user, file }], participants:Set }

app.post("/upload-audio", upload.single("audio"), (req, res) => {
  const { roomId, userName } = req.body;

  if (!callRecordings[roomId]) {
    callRecordings[roomId] = { audioFiles: [], participants: new Set() };
    console.log(`Recording started for room ${roomId}`);
  }

  callRecordings[roomId].audioFiles.push({ user: userName, file: req.file.path });
  callRecordings[roomId].participants.add(userName);

  // 🔴 UPDATED - Show count
  console.log(`Audio of ${userName} recorded (${callRecordings[roomId].participants.size}/2)`);

  // Once both users uploaded → push to n8n
  if (callRecordings[roomId].participants.size === 2) {
    console.log(`Both users audio recorded, processing call...`);
    processCall(roomId);
  }

  res.json({ status: "ok" });
});

async function processCall(roomId) {
  const payload = {
    roomId,
    callDate: new Date().toISOString(),
    audioFiles: callRecordings[roomId].audioFiles
               .map(f => ({ user: f.user, fileName: path.basename(f.file) })),
    participants: [...callRecordings[roomId].participants]
  };

  try {
    // Use environment variable instead of hardcoded string
    await fetch(process.env.N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    console.log(`Sent to n8n successfully`);
    
    // Clean up local files
    callRecordings[roomId].audioFiles.forEach(f => fs.unlinkSync(f.file));
    delete callRecordings[roomId];
  } catch (err) {
    console.error(`Webhook send failed:`, err.message);
    delete callRecordings[roomId];
  }
}

/* ────────────────────────────────────────────────────── */
server.listen(9000, '0.0.0.0', () => console.log("Server running on http://localhost:9000"));
