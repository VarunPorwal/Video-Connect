// public/js/room.js
const socket = io();

// Parse user info from query params
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room");
const username = urlParams.get("username");
const email = urlParams.get("email");

if (!roomId || !username || !email) {
    alert("Missing room ID or user details");
} else {
    // Join the specific room
    socket.emit("join-room", { roomId, username, email });

    // Now you could render user UI etc.
    console.log(`Joined room: ${roomId} as ${username}`);
    
    // When another user joins
    socket.on("user-joined-room", (user) => {
        console.log(`${user.username} joined this room.`);

        // Optional: Start call automatically or show UI
        // socket.emit("offer", { from: ..., to: ..., offer })
    });

    socket.on("user-left", (user) => {
        console.log(`${user.username} left the room.`);
    });
}
