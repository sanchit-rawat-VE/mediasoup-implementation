import { Server } from "socket.io";
import http from "http";
import express from "express";
import cors from "cors";
import mediasoup from "mediasoup"; // Import the entire module

const app = express();
app.use(cors());

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
    transports: ["websocket", "polling"],
  },
});

httpServer.listen(7003, () => console.log("Server running on port 7003"));

// Worker & Room Data
let worker;
let rooms = {}; // { roomName1: { Router, peers: [ socketId1, ... ] }, ...}
let peers = {}; // { socketId1: { socket, transports, producers, consumers, roomName }, ...}
let transports = [];
let producers = [];
let consumers = [];

(async () => {
  worker = await createWorker();
})();

async function createWorker() {
  const worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });

  console.log(`Worker PID: ${worker.pid}`);

  worker.on("died", () => {
    console.error("Mediasoup worker has died. Exiting...");
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
}

function getRemotePeerId(currentSocketId) {
  const roomName = peers[currentSocketId]?.roomName;
  if (!roomName || !rooms[roomName]) return [];
  return rooms[roomName].peers.filter((id) => id !== currentSocketId); // Return array
}

// Supported media codecs
const mediaCodecs = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "profile-level-id": "42e01f", // Baseline profile
    },
    rtcpFeedback: [{ type: "nack" }, { type: "goog-remb" }],
  },
];

io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  socket.emit("connection-success", { socketId: socket.id });

  socket.on("disconnect", () => handleDisconnect(socket));

  socket.on("joinRoom", async ({ roomName }, callback) => {
    console.log(`Client ${socket.id} joining room: ${roomName}`);

    const router1 = await createRoom(roomName);

    peers[socket.id] = {
      socket,
      roomName,
      transports: [],
      producers: [],
      consumers: [],
    };

    callback({ rtpCapabilities: router1.rtpCapabilities });
  });

  socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
    console.log(`Creating WebRTC transport for ${socket.id}`);

    if (!peers[socket.id]) return callback({ error: "Peer not found" });

    const roomName = peers[socket.id].roomName;
    const router = rooms[roomName]?.router;

    if (!router) return callback({ error: "No router found" });

    try {
      const transport = await createWebRtcTransport(router);

      transports.push({ socketId: socket.id, transport, roomName, consumer });
      peers[socket.id].transports.push(transport.id);

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });
    } catch (error) {
      console.error("Error creating WebRTC Transport:", error);
      callback({ error: error.message });
    }
  });

  socket.on("ice-candidate", ({ candidate }) => {
    const roomName = peers[socket.id]?.roomName;
    if (!roomName) return;

    // Send candidate to all peers in the room except sender
    rooms[roomName].peers.forEach((peerId) => {
      if (peerId !== socket.id && peers[peerId]) {
        peers[peerId].socket.emit("ice-candidate", { candidate });
      }
    });
  });

  socket.on("transport-connect", async ({ dtlsParameters }) => {
    console.log(`Connecting transport for ${socket.id}`);
    const transport = getTransport(socket.id);

    if (!transport) {
      console.error(`No transport found for ${socket.id}`);
      return;
    }

    if (transport.appData.connected) {
      console.warn(`Transport already connected for ${socket.id}`);
      return;
    }

    try {
      await transport.connect({ dtlsParameters });
      transport.appData.connected = true; // Mark as connected
      console.log(`Transport connected for ${socket.id}`);
    } catch (error) {
      console.error(`Error connecting transport for ${socket.id}:`, error);
    }
  });

  socket.on("getProducers", (callback) => {
    const roomName = peers[socket.id]?.roomName;
    if (!roomName) return callback([]);

    console.log(`📡 Current producers in room ${roomName}:`);
    producers.forEach((p) =>
      console.log(`- 🟢 Producer ID: ${p.producer.id}, Socket: ${p.socketId}`)
    );
    // Get all producers in the room except the current user's
    const producerList = producers
      .filter(
        (producer) =>
          producer.socketId !== socket.id && producer.roomName === roomName
      )
      .map((producer) => producer.producer.id);

    callback(producerList);
  });

  socket.on("transport-produce", async ({ kind, rtpParameters }, callback) => {
    const transport = getTransport(socket.id);
    if (!transport) return callback({ error: "No transport found" });

    const producer = await transport.produce({
      kind,
      rtpParameters,
      paused: false,
      appData: { peerId: socket.id }, // Add this line to include peerId
    });

    console.log(`✅ Producer created - ID: ${producer.id}, Kind: ${kind}`);

    const roomName = peers[socket.id].roomName;
    addProducer(producer, roomName);

    informConsumers(roomName, socket.id, producer.id);

    producer.on("transportclose", () => producer.close());
    producer.on("close", () => {
      console.warn(`⚠️ Producer closed: ${producer.id}`);
    });

    // ✅ Only request keyframe for video producers
    if (
      producer.kind === "video" &&
      typeof producer.requestKeyFrame === "function"
    ) {
      setTimeout(() => {
        console.log("🔄 Requesting keyframe for producer:", producer.id);
        producer.requestKeyFrame();
      }, 500);
    } else {
      console.log(
        `⚠️ Keyframe request skipped for producer ${producer.id} (Kind: ${producer.kind})`
      );
    }

    callback({ id: producer.id, producersExist: producers.length > 1 });
  });

  socket.on("consumer-resume", async ({ serverConsumerId }) => {
    console.log(`Resuming consumer ${serverConsumerId}`);
    const consumerEntry = consumers.find(
      (c) => c.consumer.id === serverConsumerId
    );
    if (consumerEntry) {
      try {
        await consumerEntry.consumer.resume();
        console.log(`✅ Consumer ${serverConsumerId} resumed`);
      } catch (error) {
        console.error(
          `❌ Failed to resume consumer ${serverConsumerId}:`,
          error
        );
      }
    } else {
      console.error(`❌ Consumer ${serverConsumerId} not found`);
    }
  });

  socket.on(
    "consume",
    async (
      { rtpCapabilities, remoteProducerId, serverConsumerTransportId },
      callback
    ) => {
      console.log(`Consuming producer: ${remoteProducerId}`);

      if (remoteProducerId === socket.id) {
        callback({ error: "Cannot consume own producer" });
        return;
      }

      const roomName = peers[socket.id].roomName;
      const router = rooms[roomName]?.router;
      const consumerTransport = transports.find(
        (t) => t.consumer && t.transport.id === serverConsumerTransportId
      )?.transport;

      if (!router || !consumerTransport)
        return callback({ error: "No router or consumer transport" });

      if (
        router.canConsume({ producerId: remoteProducerId, rtpCapabilities })
      ) {
        const consumer = await consumerTransport.consume({
          producerId: remoteProducerId,
          rtpCapabilities,
          paused: true,
          appData: { peerId: socket.id }, // Add this line to include peerId
        });

        console.log(
          `✅ Consumer successfully created - ID: ${consumer.id}, Kind: ${consumer.kind}`
        );

        await consumer.resume();
        console.log(`▶️ Consumer ${consumer.id} resumed`);

        consumer.on("producerclose", () => {
          console.log("emitting producer closed.");
          socket.emit("producer-closed", { remoteProducerId });
        });

        addConsumer(consumer, roomName);

        callback({
          params: {
            id: consumer.id,
            producerId: remoteProducerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          },
        });

        if (consumer.kind === "video") {
          setTimeout(() => {
            console.log("🔄 Requesting keyframe for consumer:", consumer.id);
            consumer.requestKeyFrame();
          }, 500);
        }
      }
    }
  );

  socket.on("request-keyframe", ({ producerId }) => {
    console.log(`🔄 Received keyframe request for producer: ${producerId}`);

    // Find producer in stored producers array
    const producerEntry = producers.find((p) => p.producer.id === producerId);

    if (!producerEntry) {
      console.warn(
        `⚠️ No valid producer found for keyframe request: ${producerId}`
      );
      return;
    }

    const producer = producerEntry.producer;

    console.log("🔍 Checking producer details:", producer);

    if (!producer || producer.closed) {
      console.warn(`⚠️ Producer ${producerId} is already closed or undefined.`);
      return;
    }

    if (producer.kind !== "video") {
      console.warn(
        `⚠️ Skipping keyframe request: Producer ${producerId} is not a video producer.`
      );
      return;
    }

    if (typeof producer.requestKeyFrame === "function") {
      console.log(`🔄 Requesting keyframe for producer: ${producerId}`);
      console.log(
        "🔍 Producer object before keyframe request:",
        JSON.stringify(producer, null, 2)
      );
      producer.requestKeyFrame();
    } else {
      console.warn(
        `⚠️ Producer ${producerId} does not support keyframe requests or is invalid.`
      );
    }
  });
});

function handleDisconnect(socket) {
  console.log(`Peer ${socket.id} disconnected. Cleaning up...`);
  setTimeout(() => {
    if (!io.sockets.sockets.get(socket.id)) {
      console.log(`Peer ${socket.id} did not reconnect. Removing...`);
      delete peers[socket.id];
    } else {
      console.log(`Peer ${socket.id} reconnected. No cleanup needed.`);
    }
  }, 5000);
}

async function createRoom(roomName) {
  if (rooms[roomName]) return rooms[roomName].router;

  const router = await worker.createRouter({ mediaCodecs });
  rooms[roomName] = { router, peers: [] };

  return router;
}

async function createWebRtcTransport(router) {
  const options = {
    // listenIps: [{ ip: "0.0.0.0", announcedIp: "192.168.1.10" }],
    listenInfos: [
      {
        protocol: "udp",
        ip: "0.0.0.0",
        announcedIp: "192.168.1.10",
        portRange: [40000, 49999],
      },
      {
        protocol: "tcp",
        ip: "0.0.0.0",
        announcedIp: "192.168.1.10",
        portRange: [40000, 49999],
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      // { urls: "stun:100.25.178.223:3478" },
      // {
      //   urls: "turn:100.25.178.223:3478",
      //   username: "webrtcuser",
      //   credential: "@dm!n@789",
      // },
    ],
    iceTransportPolicy: "all", // ✅ Forces use of TURN relay candidates
  };

  const transport = await router.createWebRtcTransport(options);
  console.log(`Created transport ID: ${transport.id}`);

  // Initialize connection state flag
  transport.appData = { connected: false };

  transport.on("dtlsstatechange", (dtlsState) => {
    if (dtlsState === "closed") transport.close();
  });

  transport.on("icestatechange", (state) => {
    console.log(`🚦 ICE state changed: ${state}`);
  });

  transport.on("icecandidate", (candidate) => {
    console.log(`🧊 New ICE Candidate:`, candidate);
  });

  transport.on("score", (score) => {
    console.log("Transport score:", score);
  });

  return transport;
}

function getTransport(socketId) {
  return transports.find((t) => t.socketId === socketId && !t.consumer)
    ?.transport;
}

function addProducer(producer, roomName) {
  const peerId = producer.appData.peerId;
  if (!peers[peerId]) {
    console.error(`❌ Peer with ID ${peerId} not found when adding producer.`);
    return;
  }

  console.log(`✅ Storing producer ${producer.id} for peer ${peerId}`);

  producers.push({ socketId: peerId, producer, roomName });
  peers[peerId].producers.push(producer.id);
}

function informConsumers(roomName, socketId, producerId) {
  Object.values(peers).forEach((peer) => {
    if (peer.roomName === roomName && peer.socket.id !== socketId) {
      peer.socket.emit("new-producer", { producerId, peerId: socketId });
      console.log(
        `Notified peer ${peer.socket.id} about new producer ${producerId}`
      );
    }
  });
}

function addConsumer(consumer, roomName) {
  const peerId = consumer.appData.peerId;
  if (!peers[peerId]) {
    console.error(`Peer with ID ${peerId} not found when adding consumer.`);
    return;
  }

  consumers.push({ socketId: peerId, consumer, roomName });
  peers[peerId].consumers.push(consumer.id);
}
