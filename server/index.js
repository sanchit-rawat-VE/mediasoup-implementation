import express from "express";
const app = express();

import { Server } from "socket.io";
import mediasoup from "mediasoup";
import http from "http";

const httpServer = http.createServer();
httpServer.listen(7004, () => {
  console.log("listening on port: " + 7004);
});

const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow all origins for now
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
    transports: ["websocket", "polling"], // Ensure WebSockets are enabled
  },
});

// socket.io namespace (could represent a room?)
// const connections = io.of("/mediasoup");

/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer
 **/
let worker;
let rooms = {}; // { roomName1: { Router, rooms: [ sicketId1, ... ] }, ...}
let peers = {}; // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
let transports = []; // [ { socketId1, roomName1, transport, consumer }, ... ]
let producers = []; // [ { socketId1, roomName1, producer, }, ... ]
let consumers = []; // [ { socketId1, roomName1, consumer, }, ... ]

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", (error) => {
    // This implies something serious happened, so kill the application
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
  });

  return worker;
};

// We create a Worker as soon as our application starts
worker = createWorker();

// This is an Array of RtpCapabilities
// https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCodecCapability
// list of media codecs supported by mediasoup ...
// https://github.com/versatica/mediasoup/blob/v3/src/supportedRtpCapabilities.ts
const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

io.on("connection", async (socket) => {
  console.log(socket.id);
  socket.emit("connection-success", {
    socketId: socket.id,
  });

  const removeItems = (items, socketId, type) => {
    items.forEach((item) => {
      if (item.socketId === socket.id) {
        item[type].close();
      }
    });
    items = items.filter((item) => item.socketId !== socket.id);

    return items;
  };

  socket.on("disconnect", () => {
    console.log(`Peer ${socket.id} disconnected. Waiting before cleanup...`);

    // Wait 10 seconds before removing the peer, in case they reconnect
    setTimeout(() => {
      if (!io.sockets.sockets.get(socket.id)) {
        console.log(`Peer ${socket.id} did not reconnect. Cleaning up.`);
        delete peers[socket.id];
      } else {
        console.log(`Peer ${socket.id} reconnected. No cleanup needed.`);
      }
    }, 5000); // Wait 10 seconds before cleanup
  });

  socket.on("joinRoom", async ({ roomName }, callback) => {
    // create Router if it does not exist
    // const router1 = rooms[roomName] && rooms[roomName].get('data').router || await createRoom(roomName, socket.id)
    console.log("roomName", roomName);
    const router1 = await createRoom(roomName, socket.id);

    peers[socket.id] = {
      socket,
      roomName, // Name for the Router this Peer joined
      transports: [],
      producers: [],
      consumers: [],
      peerDetails: {
        name: "",
        isAdmin: false, // Is this Peer the Admin?
      },
    };

    // get Router RTP Capabilities
    const rtpCapabilities = router1.rtpCapabilities;

    // call callback from the client and send back the rtpCapabilities
    callback({ rtpCapabilities });
  });

  const createRoom = async (roomName, socketId) => {
    // worker.createRouter(options)
    // options = { mediaCodecs, appData }
    // mediaCodecs -> defined above
    // appData -> custom application data - we are not supplying any
    // none of the two are required
    let router1;
    let peers = [];
    if (rooms[roomName]) {
      router1 = rooms[roomName].router;
      peers = rooms[roomName].peers || [];
    } else {
      router1 = await worker.createRouter({ mediaCodecs });
    }

    console.log(`Router ID: ${router1.id}`, peers.length);

    rooms[roomName] = {
      router: router1,
      peers: [...peers, socketId],
    };

    return router1;
  };

  // socket.on('createRoom', async (callback) => {
  //   if (router === undefined) {
  //     // worker.createRouter(options)
  //     // options = { mediaCodecs, appData }
  //     // mediaCodecs -> defined above
  //     // appData -> custom application data - we are not supplying any
  //     // none of the two are required
  //     router = await worker.createRouter({ mediaCodecs, })
  //     console.log(`Router ID: ${router.id}`)
  //   }

  //   getRtpCapabilities(callback)
  // })

  // const getRtpCapabilities = (callback) => {
  //   const rtpCapabilities = router.rtpCapabilities

  //   callback({ rtpCapabilities })
  // }

  // Client emits a request to create server side Transport
  // We need to differentiate between the producer and consumer transports
  socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
    console.log(`🔵 Creating WebRTC transport for peer: ${socket.id}`);

    const existingTransport = transports.find(
      (t) => t.socketId === socket.id && t.consumer === consumer
    );
    if (existingTransport) {
      console.warn(`⚠️ Transport already exists for ${socket.id}, reusing it.`);
      return callback({
        error: "Transport already exists",
        params: {
          id: existingTransport.transport.id,
          iceParameters: existingTransport.transport.iceParameters,
          iceCandidates: existingTransport.transport.iceCandidates,
          dtlsParameters: existingTransport.transport.dtlsParameters,
        },
      });
    }

    if (!peers[socket.id]) {
      console.error("❌ Error: Peer not found for transport creation.");
      return callback({ error: "Peer not found (maybe disconnected?)" });
    }

    const roomName = peers[socket.id].roomName;
    const router = rooms[roomName]?.router;

    if (!router) {
      console.error(`❌ Error: No router found for room '${roomName}'`);
      return callback({ error: "No router found" });
    }

    try {
      const transport = await createWebRtcTransport(router);
      console.log(`✅ WebRTC transport created: ${transport.id}`);

      transports.push({
        socketId: socket.id,
        transport,
        roomName,
        consumer,
      });

      peers[socket.id].transports.push(transport.id);

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });

      //   addTransport(transport, roomName, consumer);
    } catch (error) {
      console.error("❌ Error creating WebRTC Transport:", error);
      callback({ error: error.message });
    }
  });

  const addTransport = (transport, roomName, consumer) => {
    transports = [
      ...transports,
      { socketId: socket.id, transport, roomName, consumer },
    ];

    peers[socket.id] = {
      ...peers[socket.id],
      transports: [...peers[socket.id].transports, transport.id],
    };
  };

  const addProducer = (producer, roomName) => {
    producers = [...producers, { socketId: socket.id, producer, roomName }];

    peers[socket.id] = {
      ...peers[socket.id],
      producers: [...peers[socket.id].producers, producer.id],
    };
  };

  const addConsumer = (consumer, roomName) => {
    // add the consumer to the consumers list
    consumers = [...consumers, { socketId: socket.id, consumer, roomName }];

    // add the consumer id to the peers list
    peers[socket.id] = {
      ...peers[socket.id],
      consumers: [...peers[socket.id].consumers, consumer.id],
    };
  };

  socket.on("getProducers", (callback) => {
    const producerIds = producers.map((p) => p.producer.id); // Extract all producer IDs
    console.log(`📡 Returning producers for ${socket.id}:`, producerIds);
    callback(producerIds);
  });

  const informConsumers = (roomName, socketId, producerId) => {
    console.log(
      `📢 Informing consumers in room: ${roomName} about producer: ${producerId}`
    );

    // Notify all peers in the room except the producer itself
    Object.values(peers).forEach((peer) => {
      if (peer.roomName === roomName && peer.socket.id !== socketId) {
        console.log(`🔵 Sending 'new-producer' event to ${peer.socket.id}`);
        peer.socket.emit("new-producer", { producerId });
      }
    });
  };

  const getTransport = (socketId) => {
    const [producerTransport] = transports.filter(
      (transport) => transport.socketId === socketId && !transport.consumer
    );
    return producerTransport.transport;
  };

  // see client's socket.emit('transport-connect', ...)
  socket.on("transport-connect", ({ dtlsParameters }) => {
    console.log(`🔵 transport-connect received for socket: ${socket.id}`);

    const transport = getTransport(socket.id);

    if (!transport) {
      console.error(`❌ Error: No transport found for socket ${socket.id}`);
      return;
    }

    if (transport._connected) {
      console.warn(
        `⚠️ Transport already connected for ${socket.id}, skipping.`
      );
      return;
    }

    try {
      console.log("✅ Connecting transport...");
      transport.connect({ dtlsParameters });
      transport._connected = true; // Mark transport as connected
    } catch (error) {
      console.error("❌ Error connecting transport:", error);
    }
  });

  // see client's socket.emit('transport-produce', ...)
  socket.on(
    "transport-produce",
    async ({ kind, rtpParameters, appData }, callback) => {
      // call produce based on the prameters from the client
      const producer = await getTransport(socket.id).produce({
        kind,
        rtpParameters,
      });

      // add producer to the producers array
      const { roomName } = peers[socket.id];

      console.log(`Producer ID: ${producer.id} (${kind})`);

      addProducer(producer, roomName);

      informConsumers(roomName, socket.id, producer.id);

      producer.on("transportclose", () => {
        console.log("transport for this producer closed ");
        producer.close();
      });

      // Send back to the client the Producer's id
      callback({
        id: producer.id,
        producersExist: producers.length > 1 ? true : false,
      });
    }
  );

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on(
    "transport-recv-connect",
    async ({ dtlsParameters, serverConsumerTransportId }) => {
      console.log(`DTLS PARAMS: ${dtlsParameters}`);
      const consumerTransport = transports.find(
        (transportData) =>
          transportData.consumer &&
          transportData.transport.id == serverConsumerTransportId
      ).transport;
      await consumerTransport.connect({ dtlsParameters });
    }
  );

  socket.on(
    "consume",
    async (
      { rtpCapabilities, remoteProducerId, serverConsumerTransportId },
      callback
    ) => {
      console.log(
        `📥 Received 'consume' request from ${socket.id} for producer: ${remoteProducerId}`
      );

      try {
        const { roomName } = peers[socket.id];
        if (!roomName || !rooms[roomName]) {
          console.error(`❌ No room found for ${socket.id}`);
          return callback({ error: "Room not found" });
        }
        const router = rooms[roomName].router;
        let consumerTransport = transports.find(
          (transportData) =>
            transportData.consumer &&
            transportData.transport.id == serverConsumerTransportId
        ).transport;

        if (!consumerTransport) {
          console.error(
            `❌ No consumer transport found for ID: ${serverConsumerTransportId}`
          );
          return callback({ error: "Consumer transport not found" });
        }

        if (
          !router.canConsume({ producerId: remoteProducerId, rtpCapabilities })
        ) {
          console.error(
            `❌ Router cannot consume producer ${remoteProducerId}`
          );
          return callback({ error: "Cannot consume producer" });
        }

        // check if the router can consume the specified producer
        if (
          router.canConsume({
            producerId: remoteProducerId,
            rtpCapabilities,
          })
        ) {
          // transport can now consume and return a consumer
          const consumer = await consumerTransport.consume({
            producerId: remoteProducerId,
            rtpCapabilities,
            paused: true,
          });

          consumer.on("transportclose", () => {
            console.log(
              `🚪 Consumer transport closed for producer ${remoteProducerId}`
            );
          });

          consumer.on("producerclose", () => {
            console.log(`🚨 Producer ${remoteProducerId} closed.`);
            socket.emit("producer-closed", { remoteProducerId });
            consumer.close();

            // consumerTransport.close([]);
            // transports = transports.filter(
            //   (transportData) =>
            //     transportData.transport.id !== consumerTransport.id
            // );
            // consumer.close();
            // consumers = consumers.filter(
            //   (consumerData) => consumerData.consumer.id !== consumer.id
            // );
          });

          //   consumers.push({ socketId: socket.id, consumer, roomName });
          addConsumer(consumer, roomName);

          console.log(`✅ Consumer created for producer ${remoteProducerId}`);

          // from the consumer extract the following params
          // to send back to the Client
          const params = {
            id: consumer.id,
            producerId: remoteProducerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            serverConsumerId: consumer.id,
          };

          // send the parameters to the client
          callback({ params });
          console.log(
            `📡 Sending 'consumer-resume' for producer ${remoteProducerId}`
          );
        }
      } catch (error) {
        console.error("❌ Error in consume event:", error);
        callback({ error: error.message });
      }
    }
  );

  socket.on("consumer-resume", async ({ serverConsumerId }) => {
    console.log(`🎬 Resuming consumer: ${serverConsumerId}`);

    const consumerData = consumers.find(
      (c) => c.consumer.id === serverConsumerId
    );
    if (!consumerData) {
      console.error(`❌ Consumer ${serverConsumerId} not found.`);
      return;
    }

    try {
      await consumerData.consumer.resume();
      console.log(`✅ Consumer ${serverConsumerId} resumed successfully.`);
    } catch (error) {
      console.error(`❌ Error resuming consumer ${serverConsumerId}:`, error);
    }
  });
});

const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
    try {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: "0.0.0.0", // replace with relevant IP address
            announcedIp: "192.168.0.1",
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          {
            urls: "turn:relay1.expressturn.com:3478",
            username: "ef1a7864",
            credential: "eJYqTTYX",
          },
        ],
      };

      // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
      let transport = await router.createWebRtcTransport(
        webRtcTransport_options
      );
      console.log(`transport id: ${transport.id}`);

      transport.on("dtlsstatechange", (dtlsState) => {
        if (dtlsState === "closed") {
          transport.close();
        }
      });

      transport.on("close", () => {
        console.log("transport closed");
      });

      resolve(transport);
    } catch (error) {
      reject(error);
    }
  });
};
