import React, { useEffect, useState, useRef, useCallback } from "react";
import * as mediasoupClient from "mediasoup-client";
import { useSocket } from "./components/SocketProvider";
import "./components/VideoComponent.css"; // Or your chosen CSS method

const WebRTCManagerr = () => {
  const socket = useSocket();
  const [roomName, setRoomName] = useState("");
  const [joined, setJoined] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({}); // { [peerId]: MediaStream }

  const [producers, setProducers] = useState([]);
  const deviceRef = useRef(new mediasoupClient.Device());
  const producerTransportRef = useRef(null);
  const consumerTransportsRef = useRef([]);
  const producersRef = useRef({});
  const localProducerIds = useRef([]);
  const consumedProducerIds = useRef(new Set()); // Track consumed producer IDs

  const joinRoom = async (e) => {
    e.preventDefault();
    if (!roomName) return;

    socket.emit("joinRoom", { roomName }, async ({ rtpCapabilities }) => {
      try {
        if (!rtpCapabilities) {
          console.error("Error: No RTP Capabilities received");
          return;
        }

        console.log(
          "Successfully joined room, received RTP Capabilities:",
          rtpCapabilities
        );

        await deviceRef.current.load({
          routerRtpCapabilities: rtpCapabilities,
        });
        setJoined(true);
        await initTransports();
      } catch (error) {
        console.error("Error joining room:", error);
      }
    });
  };

  // Fix in initTransports:
  const initTransports = async () => {
    try {
      // console.log("🔵 Creating send transport first...");
      if (!producerTransportRef.current) {
        const producerTransport = await createTransport("producer");
        if (!producerTransport) {
          console.error("❌ Failed to create producer transport");
          return;
        }
        producerTransportRef.current = producerTransport;
      } else {
        console.warn(
          "⚠️ Producer transport already exists, skipping recreation."
        );
      }

      console.log("✅ Send transport created. Now creating producers...");

      await getLocalStream();

      console.log("🔵 Fetching existing producers...");

      const existingProducers = await new Promise((resolve) => {
        socket.timeout(5000).emit("getProducers", (err, producerList) => {
          if (err) {
            console.error(err);
            resolve([]);
          } else {
            // Filter out local producers
            const filtered = producerList.filter(
              (id) =>
                !localProducerIds.current.includes(id) &&
                !consumedProducerIds.current.has(id)
            );
            resolve(filtered);
          }
        });
      });

      existingProducers.forEach((producerId) => {
        console.log(
          `🔵 Creating consumer transport for producer: ${producerId}`
        );
        signalNewConsumerTransport(producerId);
      });
    } catch (error) {
      console.error("❌ Error in initTransports:", error);
    }
  };

  const createTransport = useCallback(
    async (type) => {
      if (type === "producer" && producerTransportRef.current) {
        console.warn("Producer transport already exists, skipping creation");
        return producerTransportRef.current;
      }

      console.log(
        `🔵 Creating transport: type=${type}, existing count=${consumerTransportsRef.current.length}`
      );

      const { params, error } = await socket.emitWithAck(
        "createWebRtcTransport",
        {
          consumer: type === "consumer",
        }
      );

      if (error) {
        if (error === "Transport already exists") {
          // Find the existing transport and return it
          const existing = consumerTransportsRef.current.find(
            (t) => t.consumer === (type === "consumer")
          );
          if (existing) return existing;
        }
        console.error("❌ Error creating WebRTC transport:", error);
        return null;
      }

      console.log("✅ Transport Params received:", params);

      const transport =
        type === "producer"
          ? deviceRef.current.createSendTransport(params)
          : deviceRef.current.createRecvTransport(params);

      transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
        try {
          if (transport._connected) {
            console.warn(
              "⚠️ Transport already connected, skipping duplicate connection."
            );
            return;
          }
          transport._connected = true;
          socket.emit("transport-connect", {
            dtlsParameters,
          });
          callback();
        } catch (error) {
          errback(error);
        }
      });

      if (type === "producer") {
        transport.on(
          "produce",
          async ({ kind, rtpParameters }, callback, errback) => {
            try {
              const { id } = await socket.emitWithAck("transport-produce", {
                kind,
                rtpParameters,
              });
              callback({ id });
            } catch (error) {
              errback(error);
            }
          }
        );
        producerTransportRef.current = transport;
      } else {
        consumerTransportsRef.current.push(transport);
      }

      return transport;
    },
    [consumerTransportsRef, deviceRef, producerTransportRef, socket]
  );

  const getLocalStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      stream.getTracks().forEach((track) => {
        track.enabled = true; // Explicitly enable all tracks
      });
      setLocalStream(stream);
      await produceMedia(stream);
    } catch (err) {
      console.error("Error getting media:", err);
      alert("Failed to access camera/microphone. Please check permissions.");
      leaveRoom(); // Reset state
    }
  };

  const produceMedia = async (stream) => {
    console.log("🎥 Producing media...");
    const tracks = stream.getTracks();
    for (const track of tracks) {
      track.enabled = true;
      const producer = await producerTransportRef.current.produce({
        track,
        appData: { source: track.kind },
      });

      console.log(
        `✅ Producer created - ID: ${producer.id}, Kind: ${track.kind}`
      );

      producersRef.current[producer.id] = producer;
      localProducerIds.current.push(producer.id); // Track local producer IDs

      if (
        producer.kind === "video" &&
        typeof producer.requestKeyFrame === "function"
      ) {
        setInterval(() => {
          if (!producer.closed) {
            console.log("🔄 Requesting keyframe...");
            producer.requestKeyFrame();
          }
        }, 2000);
      }
    }
  };

  const signalNewConsumerTransport = useCallback(
    async (producerId, peerId) => {
      console.log(`🔵 Setting up consumer for producer ${producerId}`);

      if (
        localProducerIds.current.includes(producerId) ||
        consumedProducerIds.current.has(producerId)
      ) {
        console.log(`Skipping self-consumption or already consumed producer.`);
        return;
      }

      if (producerId === socket.id) {
        console.log("Skipping self-consumption");
        return;
      }
      // ✅ Check if a consumer transport already exists
      let transport = consumerTransportsRef.current.find((t) => !t.closed);

      if (!transport) {
        transport = await createTransport("consumer");
        consumerTransportsRef.current.push(transport);
      }

      console.log(
        `✅ Using consumer transport (ID: ${transport.id}) for producer ${producerId}...`
      );

      const { params, error } = await socket.emitWithAck("consume", {
        rtpCapabilities: deviceRef.current.rtpCapabilities,
        remoteProducerId: producerId,
        serverConsumerTransportId: transport.id, // ✅ Use existing transport
      });

      if (error) {
        console.error("❌ Error consuming producer:", error);
        return;
      }

      const consumer = await transport.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
        paused: false, // ✅ Ensure it starts playing
      });

      consumer.track.enabled = true;
      setTimeout(() => consumer.resume(), 500); // Resume after a short delay

      console.log(
        `✅ Consumed track: ${consumer.track.id}, Kind: ${consumer.track.kind}, Enabled: ${consumer.track.enabled}`
      );

      console.log(`Track initial state: 
        muted: ${consumer.track.muted}, 
        enabled: ${consumer.track.enabled}, 
        readyState: ${consumer.track.readyState}
        kind: ${consumer.track.kind}`);

      console.log(
        `📡 Received track from producer ${producerId}:`,
        consumer.track
      );

      consumedProducerIds.current.add(producerId); // Mark as consumed

      // Ensure tracks are added to correct MediaStream
      setRemoteStreams((prev) => {
        const newStreams = { ...prev };
        if (!newStreams[peerId]) newStreams[peerId] = new MediaStream();
        newStreams[peerId].addTrack(consumer.track);
        return newStreams;
      });

      socket.emit("consumer-resume", { serverConsumerId: params.id });

      socket.emit("request-keyframe", { producerId: consumer.producerId });
    },
    [
      consumerTransportsRef,
      createTransport,
      deviceRef,
      socket,
      setRemoteStreams,
    ]
  );

  const leaveRoom = () => {
    localStream.getTracks().forEach((track) => track.stop());
    producerTransportRef.current?.close();
    consumerTransportsRef.current.forEach((transport) => transport.close());
    socket.disconnect();
    setJoined(false);
    setLocalStream(null);
    setRemoteStreams([]);
    localProducerIds.current = []; // Reset local producers
    consumedProducerIds.current = new Set(); // Reset consumed IDs
    consumerTransportsRef.current = []; // Clear consumer transports
  };

  useEffect(() => {
    if (socket) {
      socket.on("connection-success", (data) => {
        console.log("Connected to socket:", data);
      });

      socket.on("disconnect", () => {
        console.error("Socket disconnected! Reconnecting...");
        socket.connect();
      });

      return () => {
        console.log("Cleaning up WebRTC Manager");
      };
    }
  }, [socket]);

  useEffect(() => {
    if (!socket) return;

    // console.log("🔵 Checking socket connection:", socket.connected);

    socket.on("connect", () => {
      console.log("✅ Socket connected successfully.");
    });

    socket.on("disconnect", () => {
      console.warn("❌ Socket disconnected! Attempting to reconnect...");
    });

    socket.on("reconnect_attempt", () => {
      console.warn("⚠️ Trying to reconnect...");
    });

    return () => {
      console.log("Cleaning up socket listeners...");
      socket.off("connect");
      socket.off("disconnect");
      socket.off("reconnect_attempt");
    };
  }, [socket]);

  useEffect(() => {
    console.log(
      "🔄 useEffect triggered! Current remoteStreams:",
      remoteStreams
    );
  }, [remoteStreams]);

  useEffect(() => {
    if (!socket) return;

    console.log("Remote Streams", remoteStreams);
    socket.on("new-producer", async ({ producerId, peerId }) => {
      console.log(`📡 New producer from peer ${peerId}: ${producerId}`);

      // Skip if already consuming this producer
      if (consumedProducerIds.current.has(producerId)) {
        console.log(`🔄 Already consuming ${producerId}, skipping`);
        return;
      }

      // Fetch latest producers to check for missed tracks
      const producers = await socket.emitWithAck("getProducers");

      // Consume all relevant producers for this peer
      for (const otherProducerId of producers) {
        if (
          !localProducerIds.current.includes(otherProducerId) &&
          !consumedProducerIds.current.has(otherProducerId)
        ) {
          console.log(`🔄 Consuming ${otherProducerId} from ${peerId}`);
          await signalNewConsumerTransport(otherProducerId, peerId);
        }
      }
    });

    return () => {
      socket.off("new-producer");
    };
  }, [socket, signalNewConsumerTransport, remoteStreams]);

  return (
    <div className="container">
      {!joined ? (
        <form onSubmit={joinRoom}>
          <input
            type="text"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder="Enter room name"
          />
          <button type="submit">Join Room</button>
        </form>
      ) : (
        <div>
          <button onClick={leaveRoom}>Leave Room</button>
          <div className="video-container">
            <VideoComponent
              localStream={localStream}
              remoteStreams={remoteStreams}
              isLocal={true}
            />
          </div>
        </div>
      )}
    </div>
  );
};

const VideoComponent = ({ localStream, remoteStreams }) => {
  const localVideoRef = useRef(null);
  const remoteVideoRefs = useRef({});
  // Handle local stream
  useEffect(() => {
    if (localStream && localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
      localVideoRef.current.onloadedmetadata = () => {
        localVideoRef.current.play().catch((error) => {
          console.error("Error playing local video:", error);
        });
      };
    }
  }, [localStream]);

  // Handle remote streams
  useEffect(() => {
    Object.entries(remoteStreams).forEach(([peerId, stream]) => {
      console.log(`🖥 Updating video for ${peerId}`, stream);
      console.log("🔍 Stream Tracks:", stream.getTracks());

      const videoElement = remoteVideoRefs.current[peerId];

      if (!videoElement) {
        console.warn(`⚠️ Video element for peer ${peerId} not found`);
        return;
      }

      videoElement.srcObject = stream;

      console.log(
        `🎥 Setting srcObject for ${peerId}:`,
        videoElement.srcObject
      );

      videoElement.onloadedmetadata = () => {
        videoElement
          .play()
          .catch((error) => console.error("❌ Play error:", error));
      };

      stream.getTracks().forEach((track) => {
        console.log(
          `Track ID: ${track.id}, Kind: ${track.kind}, Enabled: ${track.enabled}, Muted: ${track.muted}`
        );
      });
    });
  }, [remoteStreams]);

  return (
    <div className="video-container">
      {/* Local Video */}
      <div className="video-wrapper local-video">
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          className="video-element"
          style={{ transform: "scaleX(-1)" }}
        />
        <div className="video-label">You</div>
      </div>

      {/* Remote Videos */}
      {Object.entries(remoteStreams).map(([peerId, stream]) => (
        <div key={peerId} className="video-wrapper">
          <video
            ref={(el) => (remoteVideoRefs.current[peerId] = el)}
            autoPlay
            playsInline
            muted={false}
            className="video-element"
            onCanPlay={() => remoteVideoRefs.current[peerId]?.play()}
          />
          <div className="video-label">User {peerId.slice(-4)}</div>
        </div>
      ))}
    </div>
  );
};

export default WebRTCManagerr;
