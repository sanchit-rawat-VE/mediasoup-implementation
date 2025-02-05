import React, { useEffect, useState, useRef, useCallback } from "react";
import * as mediasoupClient from "mediasoup-client";
import { useSocket } from "./SocketProvider";

const WebRTCManager = () => {
  const socket = useSocket();
  const [roomName, setRoomName] = useState("");
  const [joined, setJoined] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState([]);
  const [producers, setProducers] = useState([]);
  const deviceRef = useRef(new mediasoupClient.Device());
  const producerTransportRef = useRef(null);
  const consumerTransportsRef = useRef([]);
  const producersRef = useRef({});
  const [forceUpdate, setForceUpdate] = useState(false); // ✅ Added this
  const localProducerIds = useRef([]);
  const remoteVideoRef = useRef([]);

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
        // await getLocalStream();
      } catch (error) {
        console.error("Error joining room:", error);
      }
    });
  };

  // Fix in initTransports:
  const initTransports = async () => {
    try {
      console.log("🔵 Creating send transport first...");
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
            const remoteProducers = producerList.filter(
              (producerId) => !localProducerIds.current.includes(producerId)
            );
            resolve(remoteProducers);
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
      setLocalStream(stream);
      await produceMedia(stream);
    } catch (err) {
      console.error("Error getting media:", err);
    }
  };

  const produceMedia = async (stream) => {
    console.log("🎥 Local stream tracks:", stream.getTracks());
    const tracks = stream.getTracks();
    for (const track of tracks) {
      const producer = await producerTransportRef.current.produce({ track });
      producersRef.current[producer.id] = producer;
      localProducerIds.current.push(producer.id); // Track local producer IDs
      setProducers((prev) => [...prev, producer.id]);
    }
  };
  const signalNewConsumerTransport = useCallback(
    async (producerId) => {
      if (localProducerIds.current.includes(producerId)) {
        console.log(`🔄 Producer ${producerId} is local, skipping.`);
        return;
      }

      console.log(
        `🚀 Attempting to create consumer transport for producer: ${producerId}`
      );
      // ✅ Check if a consumer transport already exists
      let transport = consumerTransportsRef.current.find(
        (t) => t.type === "consumer"
      );

      if (!transport) {
        console.log("🔵 No existing consumer transport found, creating one...");
        transport = await createTransport("consumer");

        if (!transport) {
          console.error("❌ Failed to create consumer transport.");
          return;
        }

        consumerTransportsRef.current.push(transport);
      } else {
        console.log("🔄 Reusing existing consumer transport.");
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
      });

      console.log(
        `📡 Received track from producer ${producerId}:`,
        consumer.track
      );

      // ✅ Ensure tracks are added to the same MediaStream
      setRemoteStreams((prev) => {
        let updatedStreams = [...prev];
        const existingIndex = updatedStreams.findIndex(
          (s) => s.id === socket.id
        );
        let combinedStream =
          existingIndex !== -1
            ? updatedStreams[existingIndex].stream
            : new MediaStream();

        // Add the track to the combined stream if it's not already there
        if (
          !combinedStream
            .getTracks()
            .some((track) => track.id === consumer.track.id)
        ) {
          combinedStream.addTrack(consumer.track);
        }

        // Update or add the combined stream to remoteStreams
        if (existingIndex !== -1) {
          updatedStreams[existingIndex] = {
            id: socket.id,
            stream: combinedStream,
          };
        } else {
          updatedStreams.push({ id: socket.id, stream: combinedStream });
        }
        return updatedStreams;
      });

      socket.emit("consumer-resume", {
        serverConsumerId: params.serverConsumerId,
      });
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
    producerTransportRef.current.close();
    consumerTransportsRef.current.forEach((transport) => transport.close());
    socket.disconnect();
    setJoined(false);
    setLocalStream(null);
    setRemoteStreams([]);
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

    console.log("🔵 Checking socket connection:", socket.connected);

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
    if (!socket) {
      console.warn(
        "❌ Socket not initialized. Cannot listen for 'new-producer'."
      );
      return;
    }

    console.log("✅ Setting up listener for 'new-producer'...");

    socket.on("new-producer", async ({ producerId }) => {
      console.log(
        `📡 Received 'new-producer' event for producer: ${producerId}`
      );

      // ✅ Check if this producer ID has already been consumed
      if (remoteStreams.some((s) => s.id === producerId)) {
        console.log(`🔄 Producer ${producerId} is already consumed, skipping.`);
        return;
      }

      // Skip if this producer is local
      if (localProducerIds.current.includes(producerId)) {
        console.log(`🔄 Producer ${producerId} is local, skipping.`);
        return;
      }
      //   console.log(`👥 Current peers:`, Object.keys(peers));
      await signalNewConsumerTransport(producerId);

      // ✅ Fetch the latest producer list to check if we missed the other track
      const producers = await socket.emitWithAck("getProducers");
      console.log(`📡 Received producer list:`, producers);

      // ✅ Ensure we consume both the audio & video producers
      for (let otherProducerId of producers) {
        if (!remoteStreams.some((s) => s.id === otherProducerId)) {
          console.log(
            `🔄 Found unconsumed producer: ${otherProducerId}, consuming...`
          );
          await signalNewConsumerTransport(otherProducerId);
        }
      }
    });

    return () => {
      console.log("🧹 Removing 'new-producer' listener...");
      socket.off("new-producer");
    };
  }, [socket, signalNewConsumerTransport]);

  useEffect(() => {
    console.log("🚀 Remote streams updated:", remoteStreams);
    setForceUpdate((prev) => !prev); // This forces React to re-render
  }, [remoteStreams]);

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
            {localStream && (
              <VideoComponent stream={localStream} isLocal={true} />
            )}
            {remoteStreams.map(({ id, stream }) => (
              <VideoComponent key={id} stream={stream} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const VideoComponent = ({ stream, isLocal }) => {
  const videoRef = useRef();

  useEffect(() => {
    if (videoRef.current && stream) {
      console.log(
        `🔍 Attaching stream to ${isLocal ? "local" : "remote"} video element`,
        stream.getTracks()
      );
      console.log(`🎥 Stream tracks:`, stream.getTracks());
      stream.getTracks().forEach((track) => {
        console.log(
          `🎙️ Track kind: ${track.kind}, enabled: ${track.enabled}, readyState: ${track.readyState}`
        );
      });
      videoRef.current.srcObject = stream;

      console.log("videoRef.current.srcObject", videoRef.current.srcObject);

      videoRef.current.onloadedmetadata = () => {
        console.log("✅ Video metadata loaded, attempting playback...");
        videoRef.current
          .play()
          .then(() => console.log("🎥 Video is playing"))
          .catch((error) => console.error("❌ Error playing video:", error));
      };

      // ✅ Quick Fix 1: Force video playback when the user clicks anywhere on the page
      const forcePlay = () => {
        if (videoRef.current) {
          videoRef.current
            .play()
            .then(() => console.log("🚀 Forced video playback"))
            .catch((err) => console.error("❌ Error forcing playback:", err));
        }
      };

      document.addEventListener("click", forcePlay);

      setTimeout(() => {
        console.log(
          "🔍 Final check: video srcObject",
          videoRef.current.srcObject
        );
      }, 2000);

      return () => {
        document.removeEventListener("click", forcePlay);
      };
    }
  }, [stream]);

  return (
    <div className="video-wrapper">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        style={{ transform: isLocal ? "scaleX(-1)" : "none" }}
      />
    </div>
  );
};

export default WebRTCManager;
