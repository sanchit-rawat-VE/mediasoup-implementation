// import React, { useEffect, useState, useRef, useCallback } from "react";
// import * as mediasoupClient from "mediasoup-client";
// import { useSocket } from "./SocketProvider";

// const WebRTCManager = () => {
//   const socket = useSocket();
//   const [roomName, setRoomName] = useState("");
//   const [joined, setJoined] = useState(false);
//   const [localStream, setLocalStream] = useState(null);
//   const [remoteStreams, setRemoteStreams] = useState([]);
//   const deviceRef = useRef(new mediasoupClient.Device());
//   const producerTransportRef = useRef(null);
//   const consumerTransportsRef = useRef([]);
//   const connectedTransportsRef = useRef(new Map());

//   const joinRoom = async (e) => {
//     e.preventDefault();
//     if (!roomName) return;

//     socket.emit("joinRoom", { roomName }, async ({ rtpCapabilities }) => {
//       try {
//         if (!rtpCapabilities) {
//           console.error("Error: No RTP Capabilities received");
//           return;
//         }

//         console.log(
//           "Successfully joined room, received RTP Capabilities:",
//           rtpCapabilities
//         );
//         await deviceRef.current.load({
//           routerRtpCapabilities: rtpCapabilities,
//         });
//         setJoined(true);
//         await initTransports();
//       } catch (error) {
//         console.error("Error joining room:", error);
//       }
//     });
//   };

//   const getTransport = (type, producerId = null) => {
//     if (type === "producer") {
//       if (producerTransportRef.current) {
//         console.log(
//           "Retrieved producer transport:",
//           producerTransportRef.current
//         );
//         return producerTransportRef.current;
//       } else {
//         console.warn("Producer transport not found.");
//         return null;
//       }
//     }

//     if (type === "consumer") {
//       if (consumerTransportsRef.current.length === 0) {
//         console.warn("No consumer transports available.");
//         return null;
//       }

//       // If producerId is provided, find the transport for that producer
//       if (producerId) {
//         const transport = consumerTransportsRef.current.find(
//           (t) => t.producerId === producerId
//         );
//         if (transport) {
//           console.log(
//             `Retrieved consumer transport for producer ${producerId}:`,
//             transport
//           );
//           return transport;
//         } else {
//           console.warn(
//             `No consumer transport found for producer ${producerId}`
//           );
//           return null;
//         }
//       }

//       // Return the first consumer transport if no producerId is specified
//       console.log(
//         "Retrieved first available consumer transport:",
//         consumerTransportsRef.current[0]
//       );
//       return consumerTransportsRef.current[0];
//     }

//     console.error(
//       'Invalid transport type specified. Use "producer" or "consumer".'
//     );
//     return null;
//   };

//   const initTransports = async () => {
//     try {
//       console.log("Creating send transport...");
//       if (!producerTransportRef.current) {
//         const producerTransport = await createTransport("producer");
//         if (!producerTransport) {
//           console.error("Failed to create producer transport");
//           return;
//         }
//         producerTransportRef.current = producerTransport;
//       }

//       await getLocalStream(); // Ensure this is called to produce media

//       console.log("Fetching existing producers...");
//       const existingProducers = await new Promise((resolve) => {
//         socket.timeout(5000).emit("getProducers", (err, producerList) => {
//           err ? console.error(err) : resolve(producerList || []);
//         });
//       });

//       existingProducers.forEach((producerId) => {
//         signalNewConsumerTransport(producerId);
//       });
//     } catch (error) {
//       console.error("Error in initTransports:", error);
//     }
//   };

//   const connectTransport = (type, dtlsParameters, producerId = null) => {
//     const transport = getTransport(type, producerId);
//     if (transport) {
//       transport
//         .connect({ dtlsParameters })
//         .then(() =>
//           console.log(
//             `${
//               type === "producer" ? "Producer" : "Consumer"
//             } transport connected successfully.`
//           )
//         )
//         .catch((err) =>
//           console.error(`Error connecting ${type} transport:`, err)
//         );
//     }
//   };

//   const createTransport = useCallback(
//     async (type) => {
//       const isProducer = type === "producer";
//       const transportKey = `${socket.id}-${type}`;

//       if (connectedTransportsRef.current.get(transportKey)) {
//         console.warn(`${type} transport already connected, skipping.`);
//         return;
//       }

//       console.log(`Creating ${type} transport...`);
//       const { params, error } = await socket.emitWithAck(
//         "createWebRtcTransport",
//         { consumer: !isProducer }
//       );

//       if (error) {
//         console.error("Error creating WebRTC transport:", error);
//         return null;
//       }

//       const transport = isProducer
//         ? deviceRef.current.createSendTransport(params)
//         : deviceRef.current.createRecvTransport(params);

//       transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
//         try {
//           if (connectedTransportsRef.current.get(transportKey)) {
//             console.warn(`${type} transport already connected, skipping.`);
//             return;
//           }

//           await socket.emit("transport-connect", { dtlsParameters });
//           connectedTransportsRef.current.set(transportKey, true);
//           callback();
//         } catch (error) {
//           errback(error);
//         }
//       });

//       transport.on("connectionstatechange", (state) => {
//         console.log(`Transport connection state changed to: ${state}`);
//       });

//       transport.on("icestatechange", (state) => {
//         console.log(`ICE state changed to: ${state}`);
//       });

//       transport.on("icecandidate", (event) => {
//         if (event.candidate) {
//           socket.emit("ice-candidate", { candidate: event.candidate });
//         }
//       });

//       if (isProducer) {
//         transport.on(
//           "produce",
//           async ({ kind, rtpParameters }, callback, errback) => {
//             try {
//               const { id } = await socket.emitWithAck("transport-produce", {
//                 kind,
//                 rtpParameters,
//               });
//               callback({ id });
//             } catch (error) {
//               errback(error);
//             }
//           }
//         );
//       } else {
//         consumerTransportsRef.current.push(transport);
//       }

//       return transport;
//     },
//     [socket]
//   );

//   const getLocalStream = async () => {
//     try {
//       const stream = await navigator.mediaDevices.getUserMedia({
//         video: true,
//         audio: true,
//       });
//       setLocalStream(stream);
//       await produceMedia(stream);
//     } catch (err) {
//       console.error("Error getting media:", err);
//     }
//   };

//   const produceMedia = async (stream) => {
//     const transport = getTransport("producer");
//     if (!transport) {
//       console.error("No producer transport available.");
//       return;
//     }

//     const tracks = stream.getTracks();
//     for (const track of tracks) {
//       try {
//         const producer = await transport.produce({ track });
//         console.log("Produced track:", producer);
//       } catch (err) {
//         console.error("Error producing media:", err);
//       }
//     }
//   };

//   // const produceMedia = async (stream) => {
//   //   const tracks = stream.getTracks();
//   //   for (const track of tracks) {
//   //     await producerTransportRef.current.produce({ track });
//   //   }
//   // };

//   // const signalNewConsumerTransport = useCallback(async (producerId) => {
//   //   if (remoteStreams.some((s) => s.id === producerId)) {
//   //     console.log(`Producer ${producerId} is already consumed, skipping.`);
//   //     return;
//   //   }

//   //   const transportKey = `${socket.id}-consumer-${producerId}`;
//   //   if (connectedTransportsRef.current.get(transportKey)) {
//   //     console.log(`Consumer transport for ${producerId} already exists, skipping.`);
//   //     return;
//   //   }

//   //   const transport = await createTransport("consumer");
//   //   if (!transport) {
//   //     console.error("Failed to create consumer transport.");
//   //     return;
//   //   }

//   //   connectedTransportsRef.current.set(transportKey, true);

//   //   const { params, error } = await socket.emitWithAck("consume", {
//   //     rtpCapabilities: deviceRef.current.rtpCapabilities,
//   //     remoteProducerId: producerId,
//   //     serverConsumerTransportId: transport.id,
//   //   });

//   //   if (error) {
//   //     console.error("Error consuming producer:", error);
//   //     return;
//   //   }

//   //   const consumer = await transport.consume({
//   //     id: params.id,
//   //     producerId: params.producerId,
//   //     kind: params.kind,
//   //     rtpParameters: params.rtpParameters,
//   //   });

//   //   const stream = new MediaStream();
//   //   stream.addTrack(consumer.track);

//   //   console.log(`Adding track from producer ${producerId} to stream`, consumer.track);
//   //   setRemoteStreams((prev) => [...prev, { id: producerId, stream }]);

//   //   await socket.emit("consumer-resume", { serverConsumerId: params.id });
//   // }, [socket, deviceRef, remoteStreams]);

//   const consumeMedia = async (producerId, rtpCapabilities) => {
//     const transport = await createTransport("consumer", producerId); // Create or get the consumer transport

//     const { params, error } = await socket.emitWithAck("consume", {
//       rtpCapabilities,
//       remoteProducerId: producerId,
//       serverConsumerTransportId: transport.id,
//     });

//     if (error) {
//       console.error("Error consuming media:", error);
//       return;
//     }

//     const consumer = await transport.consume({
//       id: params.id,
//       producerId: params.producerId,
//       kind: params.kind,
//       rtpParameters: params.rtpParameters,
//     });

//     console.log("Consuming track:", consumer.track);

//     // Add track to MediaStream
//     const stream = new MediaStream();
//     stream.addTrack(consumer.track);
//     setRemoteStreams((prev) => [...prev, { id: producerId, stream }]);
//   };

//   const signalNewConsumerTransport = useCallback(
//     async (producerId, peerId) => {
//       console.log("inside signalNewConsumerTransport");
//       // if (
//       //   localProducerIds.current.includes(producerId) ||
//       //   consumedProducerIds.current.has(producerId) // Skip already consumed
//       // ) {
//       //   console.log(`🔄 Producer ${producerId} is local, skipping.`);
//       //   return;
//       // }
//       // ✅ Check if a consumer transport already exists
//       let transport = consumerTransportsRef.current.find((t) => !t.closed);

//       if (!transport) {
//         console.log("🔵 No existing consumer transport found, creating one...");
//         transport = await createTransport("consumer");

//         if (!transport) {
//           console.error("❌ Failed to create consumer transport.");
//           return;
//         }

//         consumerTransportsRef.current.push(transport);
//       } else {
//         console.log("🔄 Reusing existing consumer transport.");
//       }

//       console.log(
//         `✅ Using consumer transport (ID: ${transport.id}) for producer ${producerId}...`
//       );

//       const { params, error } = await socket.emitWithAck("consume", {
//         rtpCapabilities: deviceRef.current.rtpCapabilities,
//         remoteProducerId: producerId,
//         serverConsumerTransportId: transport.id, // ✅ Use existing transport
//       });

//       if (error) {
//         console.error("❌ Error consuming producer:", error);
//         return;
//       }

//       const consumer = await transport.consume({
//         id: params.id,
//         producerId: params.producerId,
//         kind: params.kind,
//         rtpParameters: params.rtpParameters,
//       });

//       console.log(
//         `📡 Received track from producer ${producerId}:`,
//         consumer.track
//       );

//       // consumedProducerIds.current.add(producerId); // Mark as consumed

//       // ✅ Ensure tracks are added to the same MediaStream
//       // Add to correct peer's stream
//       setRemoteStreams((prev) => {
//         console.log(`🟢 Updating remoteStreams state before:`, prev);
//         // Create a DEEP COPY of the previous state
//         const newStreams = { ...prev };

//         // Create a NEW MediaStream instance when adding tracks
//         if (!newStreams[peerId]) {
//           newStreams[peerId] = new MediaStream();
//         }

//         const existingTracks = newStreams[peerId].getTracks();
//         if (!existingTracks.some((t) => t.id === consumer.track.id)) {
//           // Clone the stream and add the new track
//           console.log(`🟢 Updating remoteStreams state after:`, newStreams);

//           newStreams[peerId] = new MediaStream([
//             ...existingTracks,
//             consumer.track,
//           ]);
//         }

//         return newStreams;
//       });

//       socket.emit("consumer-resume", {
//         serverConsumerId: params.serverConsumerId,
//       });
//     },
//     [
//       consumerTransportsRef,
//       createTransport,
//       deviceRef,
//       socket,
//       setRemoteStreams,
//     ]
//   );

//   const leaveRoom = () => {
//     if (localStream) {
//       localStream.getTracks().forEach((track) => track.stop());
//     }
//     if (producerTransportRef.current) {
//       producerTransportRef.current.close();
//     }
//     consumerTransportsRef.current.forEach((transport) => transport.close());
//     socket.disconnect();
//     setJoined(false);
//     setLocalStream(null);
//     setRemoteStreams([]);
//   };

//   useEffect(() => {
//     if (!socket) return;

//     socket.on("new-producer", async ({ producerId, peerId }) => {
//       // if (remoteStreams.some((s) => s.id === producerId)) {
//       //   console.log(`Producer ${producerId} is already consumed, skipping.`);
//       //   return;
//       // }
//       await signalNewConsumerTransport(producerId, peerId);
//     });

//     socket.on("ice-candidate", ({ candidate }) => {
//       const transport = getTransport(socket.id); // Ensure this retrieves the correct transport
//       if (candidate) {
//         transport
//           .addIceCandidate(new RTCIceCandidate(candidate))
//           .then(() => console.log("ICE candidate added successfully"))
//           .catch((err) => console.error("Error adding ICE candidate:", err));
//       }
//     });

//     return () => {
//       socket.off("new-producer");
//     };
//   }, [socket, signalNewConsumerTransport, remoteStreams]);

//   return (
//     <div className="container">
//       {!joined ? (
//         <form onSubmit={joinRoom}>
//           <input
//             type="text"
//             value={roomName}
//             onChange={(e) => setRoomName(e.target.value)}
//             placeholder="Enter room name"
//           />
//           <button type="submit">Join Room</button>
//         </form>
//       ) : (
//         <div>
//           <button onClick={leaveRoom}>Leave Room</button>
//           <div className="video-container">
//             <VideoComponent
//               localStream={localStream}
//               remoteStreams={remoteStreams}
//               isLocal={true}
//             />
//           </div>
//         </div>
//       )}
//     </div>
//   );
// };

// const VideoComponent = ({ localStream, remoteStreams }) => {
//   const localVideoRef = useRef(null);
//   const remoteVideoRefs = useRef({});
//   // Handle local stream
//   useEffect(() => {
//     if (localStream && localVideoRef.current) {
//       localVideoRef.current.srcObject = localStream;
//       localVideoRef.current.onloadedmetadata = () => {
//         localVideoRef.current.play().catch((error) => {
//           console.error("Error playing local video:", error);
//         });
//       };
//     }
//   }, [localStream]);

//   // Handle remote streams
//   useEffect(() => {
//     console.log("remote streams", remoteStreams);
//     Object.entries(remoteStreams).forEach(([peerId, stream]) => {
//       console.log("remote stream tracks:", stream.getTracks());
//       const videoElement = remoteVideoRefs.current[peerId];
//       if (!videoElement) return;

//       // Clone the stream to force refresh
//       videoElement.srcObject = new MediaStream(stream.getTracks());

//       videoElement.onloadedmetadata = () => {
//         videoElement.play().catch((error) => {
//           console.error(`Error playing ${peerId}'s video:`, error);
//         });
//       };

//       // Handle track additions/removals
//       stream.onaddtrack = () => {
//         videoElement.srcObject = new MediaStream(stream.getTracks());
//       };
//     });
//   }, [remoteStreams]);

//   return (
//     <div className="video-container">
//       {/* Local Video */}
//       <div className="video-wrapper local-video">
//         <video
//           ref={localVideoRef}
//           autoPlay
//           muted
//           playsInline
//           className="video-element"
//           style={{ transform: "scaleX(-1)" }}
//         />
//         <div className="video-label">You</div>
//       </div>

//       {/* Remote Videos */}
//       {Object.entries(remoteStreams).map(([peerId, stream]) => (
//         <div key={peerId} className="video-wrapper">
//           <video
//             ref={(el) => (remoteVideoRefs.current[peerId] = el)}
//             autoPlay
//             playsInline
//             className="video-element"
//             onCanPlay={() => remoteVideoRefs.current[peerId]?.play()}
//           />
//           <div className="video-label">User {peerId.slice(-4)}</div>
//         </div>
//       ))}
//     </div>
//   );
// };
// export default WebRTCManager;
