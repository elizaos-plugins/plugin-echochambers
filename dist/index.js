// src/client.ts
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
  watchedRooms = /* @__PURE__ */ new Set();
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
  async addWatchedRoom(roomId) {
    try {
      const rooms = await this.listRooms();
      const room = rooms.find((r) => r.id === roomId);
      if (!room) {
        throw new Error(`Room ${roomId} not found`);
      }
      this.watchedRooms.add(roomId);
      elizaLogger.success(`Now watching room: ${room.name}`);
    } catch (error) {
      elizaLogger.error("Error adding watched room:", error);
      throw error;
    }
  }
  removeWatchedRoom(roomId) {
    this.watchedRooms.delete(roomId);
    elizaLogger.success(`Stopped watching room: ${roomId}`);
  }
  getWatchedRooms() {
    return Array.from(this.watchedRooms);
  }
  async retryOperation(operation, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === retries - 1) throw error;
        const delay = RETRY_DELAY * 2 ** i;
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
      for (const room of this.config.rooms) {
        await this.addWatchedRoom(room);
      }
      elizaLogger.success(
        `\u2705 EchoChamber client started for ${this.modelInfo.username}`
      );
      elizaLogger.info(
        `Watching rooms: ${Array.from(this.watchedRooms).join(", ")}`
      );
    } catch (error) {
      elizaLogger.error("\u274C Failed to start EchoChamber client:", error);
      throw error;
    }
  }
  async stop() {
    this.watchedRooms.clear();
    elizaLogger.log("Stopping EchoChamber client...");
  }
  async listRooms(tags) {
    try {
      const url = new URL(this.apiUrl);
      if (tags == null ? void 0 : tags.length) {
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
  async shouldInitiateConversation(room) {
    try {
      const history = await this.getRoomHistory(room.id);
      if (!(history == null ? void 0 : history.length)) return true;
      const recentMessages = history.filter((msg) => msg != null).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      if (!recentMessages.length) return true;
      const lastMessageTime = new Date(
        recentMessages[0].timestamp
      ).getTime();
      const timeSinceLastMessage = Date.now() - lastMessageTime;
      const quietPeriodSeconds = Number(
        this.runtime.getSetting("ECHOCHAMBERS_QUIET_PERIOD") || 300
        // 5 minutes in seconds
      );
      const quietPeriod = quietPeriodSeconds * 1e3;
      if (timeSinceLastMessage < quietPeriod) {
        elizaLogger.debug(
          `Room ${room.name} active recently, skipping`
        );
        return false;
      }
      return true;
    } catch (error) {
      elizaLogger.error(`Error checking conversation state: ${error}`);
      return false;
    }
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

${messageCompletionFooter}`;
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

${shouldRespondFooter}`;
}
function createConversationStarterTemplate(currentRoom, roomTopic) {
  return `
# Room Context:
Room: ${currentRoom}
Topic: ${roomTopic}

# About {{agentName}}:
{{bio}}
{{lore}}
{{knowledge}}

# Task: Generate a conversation starter that:
1. Is specifically relevant to the room's topic
2. Draws from {{agentName}}'s knowledge
3. Encourages discussion and engagement
4. Is natural and conversational

Keep it concise and focused on the room's topic.
${messageCompletionFooter}`;
}
var InteractionClient = class {
  client;
  runtime;
  lastCheckedTimestamps = /* @__PURE__ */ new Map();
  lastResponseTimes = /* @__PURE__ */ new Map();
  messageThreads = /* @__PURE__ */ new Map();
  messageHistory = /* @__PURE__ */ new Map();
  pollInterval = null;
  conversationStarterInterval = null;
  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
  }
  async start() {
    const pollInterval = Number(
      this.runtime.getSetting("ECHOCHAMBERS_POLL_INTERVAL") || 60
    );
    const conversationStarterInterval = Number(
      this.runtime.getSetting(
        "ECHOCHAMBERS_CONVERSATION_STARTER_INTERVAL"
      ) || 300
    );
    const handleInteractionsLoop = () => {
      this.handleInteractions();
      this.pollInterval = setTimeout(
        handleInteractionsLoop,
        pollInterval * 1e3
      );
    };
    const conversationStarterLoop = () => {
      this.checkForDeadRooms();
      this.conversationStarterInterval = setTimeout(
        conversationStarterLoop,
        conversationStarterInterval * 1e3
      );
    };
    handleInteractionsLoop();
    conversationStarterLoop();
  }
  async stop() {
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.conversationStarterInterval) {
      clearTimeout(this.conversationStarterInterval);
      this.conversationStarterInterval = null;
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
      const watchedRooms = this.client.getWatchedRooms();
      const rooms = await this.client.listRooms();
      for (const room of rooms) {
        if (!watchedRooms.includes(room.id)) {
          continue;
        }
        const messages = await this.client.getRoomHistory(room.id);
        this.messageThreads.set(room.id, messages);
        const latestMessages = messages.filter((msg) => this.shouldProcessMessage(msg, room)).sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        if (latestMessages.length > 0) {
          const latestMessage = latestMessages[0];
          await this.handleMessage(latestMessage, room.topic);
          const roomHistory = this.messageHistory.get(room.id) || [];
          roomHistory.push({
            message: latestMessage,
            response: null
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
    var _a, _b, _c, _d;
    try {
      const content = `${(_a = message.content) == null ? void 0 : _a.substring(0, 50)}...`;
      elizaLogger2.debug("Processing message:", {
        id: message.id,
        room: message.roomId,
        sender: (_b = message == null ? void 0 : message.sender) == null ? void 0 : _b.username,
        content: `${content}`
      });
      const roomId = stringToUuid(message.roomId);
      const userId = stringToUuid(message.sender.username);
      elizaLogger2.debug("Converted IDs:", { roomId, userId });
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
        template: ((_c = this.runtime.character.templates) == null ? void 0 : _c.shouldRespondTemplate) || createShouldRespondTemplate(message.roomId, roomTopic)
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
        template: ((_d = this.runtime.character.templates) == null ? void 0 : _d.messageHandlerTemplate) || createMessageTemplate(message.roomId, roomTopic)
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
      const callback = async (content2) => {
        const sentMessage = await this.client.sendMessage(
          message.roomId,
          content2.text
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
            action: content2.action,
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
      elizaLogger2.debug("Message that caused error:", {
        message,
        roomTopic
      });
    }
  }
  async checkForDeadRooms() {
    try {
      const watchedRooms = this.client.getWatchedRooms();
      elizaLogger2.debug(
        "Starting dead room check. Watched rooms:",
        watchedRooms
      );
      const rooms = await this.client.listRooms();
      elizaLogger2.debug(
        "Available rooms:",
        rooms.map((r) => ({ id: r.id, name: r.name }))
      );
      for (const roomId of watchedRooms) {
        try {
          elizaLogger2.debug(`Checking room ${roomId}`);
          const room = rooms.find((r) => r.id === roomId);
          if (!room) {
            elizaLogger2.debug(`Room ${roomId} not found, skipping`);
            continue;
          }
          elizaLogger2.debug("Room details:", {
            id: room.id,
            name: room.name,
            topic: room.topic
          });
          const randomCheck = Math.random();
          elizaLogger2.debug(
            `Random check for ${room.name}: ${randomCheck}`
          );
          if (randomCheck > 0.8) {
            elizaLogger2.debug(
              `Checking conversation state for ${room.name}`
            );
            const shouldInitiate = await this.client.shouldInitiateConversation(room);
            elizaLogger2.debug(
              `Should initiate conversation in ${room.name}:`,
              shouldInitiate
            );
            if (shouldInitiate) {
              elizaLogger2.debug(
                `Starting conversation initiation in ${room.name}`
              );
              await this.initiateConversation(room);
              elizaLogger2.debug(
                `Completed conversation initiation in ${room.name}`
              );
            }
          }
        } catch (roomError) {
          if (roomError instanceof Error) {
            elizaLogger2.error(`Error processing room ${roomId}:`, {
              error: roomError.message,
              stack: roomError.stack
            });
          } else {
            elizaLogger2.error(`Error processing room ${roomId}:`, roomError);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        elizaLogger2.error(
          "Error in checkForDeadRooms:",
          error.message || "Unknown error"
        );
        elizaLogger2.debug("Full error details:", {
          error,
          stack: error.stack,
          type: typeof error
        });
      } else {
        elizaLogger2.error("Error in checkForDeadRooms:", String(error));
      }
    }
  }
  async initiateConversation(room) {
    var _a;
    try {
      elizaLogger2.debug(`Starting initiateConversation for ${room.name}`);
      const dummyMemory = {
        id: stringToUuid("conversation-starter"),
        userId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: stringToUuid(room.id),
        content: {
          text: "",
          source: "echochambers",
          thread: []
        },
        createdAt: Date.now(),
        embedding: getEmbeddingZeroVector()
      };
      const state = await this.runtime.composeState(dummyMemory);
      elizaLogger2.debug("Composed state for conversation");
      const context = composeContext({
        state,
        template: createConversationStarterTemplate(
          room.name,
          room.topic
        )
      });
      elizaLogger2.debug("Created conversation context");
      const content = await generateMessageResponse({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL
      });
      elizaLogger2.debug("Generated response content:", {
        hasContent: !!content,
        textLength: (_a = content == null ? void 0 : content.text) == null ? void 0 : _a.length
      });
      if (content == null ? void 0 : content.text) {
        elizaLogger2.debug(`Sending message to ${room.name}`);
        await this.client.sendMessage(room.id, content.text);
        elizaLogger2.info(
          `Started conversation in ${room.name} (Topic: ${room.topic})`
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        elizaLogger2.error(
          `Error in initiateConversation for ${room.name}:`,
          {
            error: error.message,
            stack: error.stack
          }
        );
      } else {
        elizaLogger2.error(
          `Error in initiateConversation for ${room.name}:`,
          String(error)
        );
      }
      throw error;
    }
  }
};

// src/environment.ts
import { elizaLogger as elizaLogger3 } from "@elizaos/core";
async function validateEchoChamberConfig(runtime) {
  var _a;
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
  } catch {
    elizaLogger3.error(
      `Invalid ECHOCHAMBERS_API_URL format: ${apiUrl}. Please provide a valid URL.`
    );
    throw new Error("Invalid ECHOCHAMBERS_API_URL format");
  }
  const username = runtime.getSetting("ECHOCHAMBERS_USERNAME") || `agent-${runtime.agentId}`;
  const rooms = ((_a = runtime.getSetting("ECHOCHAMBERS_ROOMS")) == null ? void 0 : _a.split(",").map((r) => r.trim())) || ["general"];
  const pollInterval = Number(
    runtime.getSetting("ECHOCHAMBERS_POLL_INTERVAL") || 120
  );
  if (Number.isNaN(pollInterval) || pollInterval < 1) {
    elizaLogger3.error(
      "ECHOCHAMBERS_POLL_INTERVAL must be a positive number in seconds"
    );
    throw new Error("Invalid ECHOCHAMBERS_POLL_INTERVAL");
  }
  elizaLogger3.log("EchoChambers configuration validated successfully");
  elizaLogger3.log(`API URL: ${apiUrl}`);
  elizaLogger3.log(`Username: ${username}`);
  elizaLogger3.log(`Watching Rooms: ${rooms.join(", ")}`);
  elizaLogger3.log(`Poll Interval: ${pollInterval}s`);
}

// src/client.ts
var EchoChamberClientInterface = {
  name: "echochamber",
  async start(runtime) {
    var _a;
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
        rooms: ((_a = runtime.getSetting("ECHOCHAMBERS_ROOMS")) == null ? void 0 : _a.split(",").map((r) => r.trim())) || ["general"]
      };
      elizaLogger4.log("Starting EchoChambers client...");
      const client = new EchoChamberClient(runtime, config);
      await client.start();
      const interactionClient = new InteractionClient(client, runtime);
      await interactionClient.start();
      elizaLogger4.success(
        `\u2705 EchoChambers client successfully started for character ${runtime.character.name}`
      );
      return {
        client,
        interactionClient,
        async stop(runtime2) {
          var _a2;
          try {
            elizaLogger4.warn("Stopping EchoChambers client...");
            const clients = (_a2 = runtime2.clients) == null ? void 0 : _a2.filter(
              (c) => c instanceof EchoChamberClient || c instanceof InteractionClient
            );
            for (const client2 of clients) {
              await client2.stop();
            }
            elizaLogger4.success("EchoChambers client stopped successfully");
          } catch (error) {
            elizaLogger4.error("Error stopping EchoChambers client:", error);
            throw error;
          }
        }
      };
    } catch (error) {
      elizaLogger4.error("Failed to start EchoChambers client:", error);
      throw error;
    }
  }
};

// src/index.ts
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
  index_default as default,
  echoChambersPlugin
};
//# sourceMappingURL=index.js.map