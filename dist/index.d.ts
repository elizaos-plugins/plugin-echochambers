import { IAgentRuntime, Client, Plugin } from '@elizaos/core';

interface ModelInfo {
    username: string;
    model: string;
}
interface ChatMessage {
    id: string;
    content: string;
    sender: ModelInfo;
    timestamp: string;
    roomId: string;
}
interface ChatRoom {
    id: string;
    name: string;
    topic: string;
    tags: string[];
    participants: ModelInfo[];
    createdAt: string;
    messageCount: number;
}
interface EchoChamberConfig {
    apiUrl: string;
    apiKey: string;
    rooms: string[];
    username?: string;
    model?: string;
}
interface ListRoomsResponse {
    rooms: ChatRoom[];
}
interface RoomHistoryResponse {
    messages: ChatMessage[];
}
interface MessageResponse {
    message: ChatMessage;
}
interface CreateRoomResponse {
    room: ChatRoom;
}
interface ClearMessagesResponse {
    success: boolean;
    message: string;
}
declare enum RoomEvent {
    MESSAGE_CREATED = "message_created",
    ROOM_CREATED = "room_created",
    ROOM_UPDATED = "room_updated",
    ROOM_JOINED = "room_joined",
    ROOM_LEFT = "room_left"
}
interface MessageTransformer {
    transformIncoming(content: string): Promise<string>;
    transformOutgoing?(content: string): Promise<string>;
}
interface ContentModerator {
    validateContent(content: string): Promise<boolean>;
}

declare class EchoChamberClient {
    private runtime;
    private config;
    private apiUrl;
    private modelInfo;
    private watchedRooms;
    constructor(runtime: IAgentRuntime, config: EchoChamberConfig);
    getUsername(): string;
    getModelInfo(): ModelInfo;
    getConfig(): EchoChamberConfig;
    private getAuthHeaders;
    addWatchedRoom(roomId: string): Promise<void>;
    removeWatchedRoom(roomId: string): void;
    getWatchedRooms(): string[];
    private retryOperation;
    start(): Promise<void>;
    stop(): Promise<void>;
    listRooms(tags?: string[]): Promise<ChatRoom[]>;
    getRoomHistory(roomId: string): Promise<ChatMessage[]>;
    sendMessage(roomId: string, content: string): Promise<ChatMessage>;
    shouldInitiateConversation(room: ChatRoom): Promise<boolean>;
}

declare class InteractionClient {
    private client;
    private runtime;
    private lastCheckedTimestamps;
    private lastResponseTimes;
    private messageThreads;
    private messageHistory;
    private pollInterval;
    private conversationStarterInterval;
    constructor(client: EchoChamberClient, runtime: IAgentRuntime);
    start(): Promise<void>;
    stop(): Promise<void>;
    private buildMessageThread;
    private shouldProcessMessage;
    private handleInteractions;
    private handleMessage;
    private checkForDeadRooms;
    private initiateConversation;
}

declare const EchoChamberClientInterface: Client;
declare const echoChambersPlugin: Plugin;

export { type ChatMessage, type ChatRoom, type ClearMessagesResponse, type ContentModerator, type CreateRoomResponse, EchoChamberClient, EchoChamberClientInterface, type EchoChamberConfig, InteractionClient, type ListRoomsResponse, type MessageResponse, type MessageTransformer, type ModelInfo, RoomEvent, type RoomHistoryResponse, echoChambersPlugin as default, echoChambersPlugin };
