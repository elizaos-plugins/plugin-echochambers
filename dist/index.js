// src/index.ts
import { elizaLogger as elizaLogger4 } from "@elizaos/core";

// src/echoChamberClient.ts
import { elizaLogger } from "@elizaos/core";
var MAX_RETRIES = 3;
var RETRY_DELAY = 5e3;
var EchoChamberClient = class {
  runtime;
  config;
  apiUrl;
  modelInfo;
  pollInterval = null;
  watchedRoom = null;
  constructor(runtime, config) {
    this.runtime = runtime;
    this.config = config;
    this.apiUrl = `${config.apiUrl}/api/rooms`;
    this.modelInfo = {
      username: config.username || `agent-${runtime.agentId}`,
      model: config.model || runtime.modelProvider
    };
  }
  getUsername() {
    return this.modelInfo.username;
  }
  getModelInfo() {
    return { ...this.modelInfo };
  }
  getConfig() {
    return { ...this.config };
  }
  getAuthHeaders() {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey
    };
  }
  async setWatchedRoom(roomId) {
    try {
      const rooms = await this.listRooms();
      const room = rooms.find((r) => r.id === roomId);
      if (!room) {
        throw new Error(`Room ${roomId} not found`);
      }
      this.watchedRoom = roomId;
      elizaLogger.success(`Now watching room: ${room.name}`);
    } catch (error) {
      elizaLogger.error("Error setting watched room:", error);
      throw error;
    }
  }
  getWatchedRoom() {
    return this.watchedRoom;
  }
  async retryOperation(operation, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === retries - 1) throw error;
        const delay = RETRY_DELAY * Math.pow(2, i);
        elizaLogger.warn(`Retrying operation in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Max retries exceeded");
  }
  async start() {
    elizaLogger.log("\u{1F680} Starting EchoChamber client...");
    try {
      await this.retryOperation(() => this.listRooms());
      elizaLogger.success(
        `\u2705 EchoChamber client successfully started for ${this.modelInfo.username}`
      );
      if (this.config.defaultRoom && !this.watchedRoom) {
        await this.setWatchedRoom(this.config.defaultRoom);
      }
    } catch (error) {
      elizaLogger.error("\u274C Failed to start EchoChamber client:", error);
      throw error;
    }
  }
  async stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.watchedRoom) {
      try {
        this.watchedRoom = null;
      } catch (error) {
        elizaLogger.error(
          `Error leaving room ${this.watchedRoom}:`,
          error
        );
      }
    }
    elizaLogger.log("Stopping EchoChamber client...");
  }
  async listRooms(tags) {
    try {
      const url = new URL(this.apiUrl);
      if (tags?.length) {
        url.searchParams.append("tags", tags.join(","));
      }
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Failed to list rooms: ${response.statusText}`);
      }
      const data = await response.json();
      return data.rooms;
    } catch (error) {
      elizaLogger.error("Error listing rooms:", error);
      throw error;
    }
  }
  async getRoomHistory(roomId) {
    return this.retryOperation(async () => {
      const response = await fetch(`${this.apiUrl}/${roomId}/history`);
      if (!response.ok) {
        throw new Error(
          `Failed to get room history: ${response.statusText}`
        );
      }
      const data = await response.json();
      return data.messages;
    });
  }
  async sendMessage(roomId, content) {
    return this.retryOperation(async () => {
      const response = await fetch(`${this.apiUrl}/${roomId}/message`, {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          content,
          sender: this.modelInfo
        })
      });
      if (!response.ok) {
        throw new Error(
          `Failed to send message: ${response.statusText}`
        );
      }
      const data = await response.json();
      return data.message;
    });
  }
};

// src/interactions.ts
import {
  composeContext,
  generateMessageResponse,
  generateShouldRespond,
  messageCompletionFooter,
  shouldRespondFooter,
  ModelClass,
  stringToUuid,
  elizaLogger as elizaLogger2,
  getEmbeddingZeroVector
} from "@elizaos/core";
function createMessageTemplate(currentRoom, roomTopic) {
  return `
# About {{agentName}}:
{{bio}}
{{lore}}
{{knowledge}}

Current Room: ${currentRoom}
Room Topic: ${roomTopic}

{{messageDirections}}

Recent conversation history:
{{recentMessages}}

Thread Context:
{{formattedConversation}}

# Task: Generate a response in the voice and style of {{agentName}} while:
1. Staying relevant to the room's topic
2. Maintaining conversation context
3. Being helpful but not overly talkative
4. Responding naturally to direct questions or mentions
5. Contributing meaningfully to ongoing discussions

Remember:
- Keep responses concise and focused
- Stay on topic for the current room
- Don't repeat information already shared
- Be natural and conversational
` + messageCompletionFooter;
}
function createShouldRespondTemplate(currentRoom, roomTopic) {
  return `
# About {{agentName}}:
{{bio}}
{{knowledge}}

Current Room: ${currentRoom}
Room Topic: ${roomTopic}

Response options are [RESPOND], [IGNORE] and [STOP].

{{agentName}} should:
- RESPOND when:
  * Directly mentioned or asked a question
  * Can contribute relevant expertise to the discussion
  * Topic aligns with their knowledge and background
  * Conversation is active and engaging

- IGNORE when:
  * Message is not relevant to their expertise
  * Already responded recently without new information to add
  * Conversation has moved to a different topic
  * Message is too short or lacks substance
  * Other participants are handling the discussion well

- STOP when:
  * Asked to stop participating
  * Conversation has concluded
  * Discussion has completely diverged from their expertise
  * Room topic has changed significantly

Recent messages:
{{recentMessages}}

Thread Context:
{{formattedConversation}}

# Task: Choose whether {{agentName}} should respond to the last message.
Consider:
1. Message relevance to {{agentName}}'s expertise
2. Current conversation context
3. Time since last response
4. Value of potential contribution
` + shouldRespondFooter;
}
var InteractionClient = class {
  client;
  runtime;
  lastCheckedTimestamps = /* @__PURE__ */ new Map();
  lastResponseTimes = /* @__PURE__ */ new Map();
  messageThreads = /* @__PURE__ */ new Map();
  messageHistory = /* @__PURE__ */ new Map();
  pollInterval = null;
  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
  }
  async start() {
    const pollInterval = Number(
      this.runtime.getSetting("ECHOCHAMBERS_POLL_INTERVAL") || 60
    );
    const handleInteractionsLoop = () => {
      this.handleInteractions();
      this.pollInterval = setTimeout(
        handleInteractionsLoop,
        pollInterval * 1e3
      );
    };
    handleInteractionsLoop();
  }
  async stop() {
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
  }
  async buildMessageThread(message, messages) {
    const thread = [];
    const maxThreadLength = Number(
      this.runtime.getSetting("ECHOCHAMBERS_MAX_MESSAGES") || 10
    );
    thread.push(message);
    const roomMessages = messages.filter((msg) => msg.roomId === message.roomId).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    for (const msg of roomMessages) {
      if (thread.length >= maxThreadLength) break;
      if (msg.id !== message.id) {
        thread.unshift(msg);
      }
    }
    return thread;
  }
  shouldProcessMessage(message, room) {
    const modelInfo = this.client.getModelInfo();
    if (message.sender.username === modelInfo.username) {
      return false;
    }
    const lastChecked = this.lastCheckedTimestamps.get(message.roomId) || "0";
    if (message.timestamp <= lastChecked) {
      return false;
    }
    const lastResponseTime = this.lastResponseTimes.get(message.roomId) || 0;
    const minTimeBetweenResponses = 3e4;
    if (Date.now() - lastResponseTime < minTimeBetweenResponses) {
      return false;
    }
    const isMentioned = message.content.toLowerCase().includes(`${modelInfo.username.toLowerCase()}`);
    const isRelevantToTopic = room.topic && message.content.toLowerCase().includes(room.topic.toLowerCase());
    return isMentioned || isRelevantToTopic;
  }
  async handleInteractions() {
    elizaLogger2.log("Checking EchoChambers interactions");
    try {
      const defaultRoom = this.runtime.getSetting(
        "ECHOCHAMBERS_DEFAULT_ROOM"
      );
      const rooms = await this.client.listRooms();
      for (const room of rooms) {
        if (defaultRoom && room.id !== defaultRoom) {
          continue;
        }
        const messages = await this.client.getRoomHistory(room.id);
        this.messageThreads.set(room.id, messages);
        const latestMessages = messages.filter((msg) => !this.shouldProcessMessage(msg, room)).sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        if (latestMessages.length > 0) {
          const latestMessage = latestMessages[0];
          await this.handleMessage(latestMessage, room.topic);
          const roomHistory = this.messageHistory.get(room.id) || [];
          roomHistory.push({
            message: latestMessage,
            response: null
            // Will be updated when we respond
          });
          this.messageHistory.set(room.id, roomHistory);
          if (latestMessage.timestamp > (this.lastCheckedTimestamps.get(room.id) || "0")) {
            this.lastCheckedTimestamps.set(
              room.id,
              latestMessage.timestamp
            );
          }
        }
      }
      elizaLogger2.log("Finished checking EchoChambers interactions");
    } catch (error) {
      elizaLogger2.error(
        "Error handling EchoChambers interactions:",
        error
      );
    }
  }
  async handleMessage(message, roomTopic) {
    try {
      const roomId = stringToUuid(message.roomId);
      const userId = stringToUuid(message.sender.username);
      await this.runtime.ensureConnection(
        userId,
        roomId,
        message.sender.username,
        message.sender.username,
        "echochambers"
      );
      const thread = await this.buildMessageThread(
        message,
        this.messageThreads.get(message.roomId) || []
      );
      const memory = {
        id: stringToUuid(message.id),
        userId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          text: message.content,
          source: "echochambers",
          thread: thread.map((msg) => ({
            text: msg.content,
            sender: msg.sender.username,
            timestamp: msg.timestamp
          }))
        },
        createdAt: new Date(message.timestamp).getTime(),
        embedding: getEmbeddingZeroVector()
      };
      const existing = await this.runtime.messageManager.getMemoryById(
        memory.id
      );
      if (existing) {
        elizaLogger2.log(
          `Already processed message ${message.id}, skipping`
        );
        return;
      }
      await this.runtime.messageManager.createMemory(memory);
      let state = await this.runtime.composeState(memory);
      state = await this.runtime.updateRecentMessageState(state);
      const shouldRespondContext = composeContext({
        state,
        template: this.runtime.character.templates?.shouldRespondTemplate || createShouldRespondTemplate(message.roomId, roomTopic)
      });
      const shouldRespond = await generateShouldRespond({
        runtime: this.runtime,
        context: shouldRespondContext,
        modelClass: ModelClass.SMALL
      });
      if (shouldRespond !== "RESPOND") {
        elizaLogger2.log(
          `Not responding to message ${message.id}: ${shouldRespond}`
        );
        return;
      }
      const responseContext = composeContext({
        state,
        template: this.runtime.character.templates?.messageHandlerTemplate || createMessageTemplate(message.roomId, roomTopic)
      });
      const response = await generateMessageResponse({
        runtime: this.runtime,
        context: responseContext,
        modelClass: ModelClass.LARGE
      });
      if (!response || !response.text) {
        elizaLogger2.log("No response generated");
        return;
      }
      const callback = async (content) => {
        const sentMessage = await this.client.sendMessage(
          message.roomId,
          content.text
        );
        this.lastResponseTimes.set(message.roomId, Date.now());
        const roomHistory = this.messageHistory.get(message.roomId) || [];
        const lastEntry = roomHistory[roomHistory.length - 1];
        if (lastEntry && lastEntry.message.id === message.id) {
          lastEntry.response = sentMessage;
        }
        const responseMemory = {
          id: stringToUuid(sentMessage.id),
          userId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId,
          content: {
            text: sentMessage.content,
            source: "echochambers",
            action: content.action,
            thread: thread.map((msg) => ({
              text: msg.content,
              sender: msg.sender.username,
              timestamp: msg.timestamp
            }))
          },
          createdAt: new Date(sentMessage.timestamp).getTime(),
          embedding: getEmbeddingZeroVector()
        };
        await this.runtime.messageManager.createMemory(responseMemory);
        return [responseMemory];
      };
      const responseMessages = await callback(response);
      state = await this.runtime.updateRecentMessageState(state);
      await this.runtime.processActions(
        memory,
        responseMessages,
        state,
        callback
      );
      await this.runtime.evaluate(memory, state, true);
    } catch (error) {
      elizaLogger2.error("Error handling message:", error);
    }
  }
};

// src/environment.ts
import { elizaLogger as elizaLogger3 } from "@elizaos/core";
async function validateEchoChamberConfig(runtime) {
  const apiUrl = runtime.getSetting("ECHOCHAMBERS_API_URL");
  const apiKey = runtime.getSetting("ECHOCHAMBERS_API_KEY");
  if (!apiUrl) {
    elizaLogger3.error(
      "ECHOCHAMBERS_API_URL is required. Please set it in your environment variables."
    );
    throw new Error("ECHOCHAMBERS_API_URL is required");
  }
  if (!apiKey) {
    elizaLogger3.error(
      "ECHOCHAMBERS_API_KEY is required. Please set it in your environment variables."
    );
    throw new Error("ECHOCHAMBERS_API_KEY is required");
  }
  try {
    new URL(apiUrl);
  } catch (error) {
    elizaLogger3.error(
      `Invalid ECHOCHAMBERS_API_URL format: ${apiUrl}. Please provide a valid URL.`
    );
    throw new Error("Invalid ECHOCHAMBERS_API_URL format");
  }
  const username = runtime.getSetting("ECHOCHAMBERS_USERNAME") || `agent-${runtime.agentId}`;
  const defaultRoom = runtime.getSetting("ECHOCHAMBERS_DEFAULT_ROOM") || "general";
  const pollInterval = Number(
    runtime.getSetting("ECHOCHAMBERS_POLL_INTERVAL") || 120
  );
  if (isNaN(pollInterval) || pollInterval < 1) {
    elizaLogger3.error(
      "ECHOCHAMBERS_POLL_INTERVAL must be a positive number in seconds"
    );
    throw new Error("Invalid ECHOCHAMBERS_POLL_INTERVAL");
  }
  elizaLogger3.log("EchoChambers configuration validated successfully");
  elizaLogger3.log(`API URL: ${apiUrl}`);
  elizaLogger3.log(`Username: ${username}`);
  elizaLogger3.log(`Default Room: ${defaultRoom}`);
  elizaLogger3.log(`Poll Interval: ${pollInterval}s`);
}

// src/types.ts
var RoomEvent = /* @__PURE__ */ ((RoomEvent2) => {
  RoomEvent2["MESSAGE_CREATED"] = "message_created";
  RoomEvent2["ROOM_CREATED"] = "room_created";
  RoomEvent2["ROOM_UPDATED"] = "room_updated";
  RoomEvent2["ROOM_JOINED"] = "room_joined";
  RoomEvent2["ROOM_LEFT"] = "room_left";
  return RoomEvent2;
})(RoomEvent || {});

// src/index.ts
var EchoChamberClientInterface = {
  async start(runtime) {
    try {
      await validateEchoChamberConfig(runtime);
      const apiUrl = runtime.getSetting("ECHOCHAMBERS_API_URL");
      const apiKey = runtime.getSetting("ECHOCHAMBERS_API_KEY");
      if (!apiKey || !apiUrl) {
        throw new Error(
          "ECHOCHAMBERS_API_KEY/ECHOCHAMBERS_API_URL is required"
        );
      }
      const config = {
        apiUrl,
        apiKey,
        username: runtime.getSetting("ECHOCHAMBERS_USERNAME") || `agent-${runtime.agentId}`,
        model: runtime.modelProvider,
        defaultRoom: runtime.getSetting("ECHOCHAMBERS_DEFAULT_ROOM") || "general"
      };
      elizaLogger4.log("Starting EchoChambers client...");
      const client = new EchoChamberClient(runtime, config);
      await client.start();
      const interactionClient = new InteractionClient(client, runtime);
      await interactionClient.start();
      elizaLogger4.success(
        `\u2705 EchoChambers client successfully started for character ${runtime.character.name}`
      );
      return { client, interactionClient };
    } catch (error) {
      elizaLogger4.error("Failed to start EchoChambers client:", error);
      throw error;
    }
  },
  async stop(runtime) {
    try {
      elizaLogger4.warn("Stopping EchoChambers client...");
      const clients = runtime.clients?.filter(
        (c) => c instanceof EchoChamberClient || c instanceof InteractionClient
      );
      for (const client of clients) {
        await client.stop();
      }
      elizaLogger4.success("EchoChambers client stopped successfully");
    } catch (error) {
      elizaLogger4.error("Error stopping EchoChambers client:", error);
      throw error;
    }
  }
};
var echoChambersPlugin = {
  name: "echochambers",
  description: "Plugin for interacting with EchoChambers API to enable multi-agent communication",
  actions: [],
  // No custom actions needed - core functionality handled by client
  evaluators: [],
  // No custom evaluators needed
  providers: [],
  // No custom providers needed
  clients: [EchoChamberClientInterface]
};
var index_default = echoChambersPlugin;
export {
  EchoChamberClient,
  EchoChamberClientInterface,
  InteractionClient,
  RoomEvent,
  index_default as default,
  echoChambersPlugin
};
//# sourceMappingURL=index.js.map