import React, { createContext, useContext, useState, useCallback } from 'react';

export interface Message {
  id: string;
  conversationId: string;
  senderId: string; // user id, or 'system'
  content: string;
  messageType: 'text' | 'system';
  createdAt: number;
}

export interface Conversation {
  id: string;
  productId: string;
  productName: string;
  productImg: string;
  productPrice: number;
  buyerId: string;
  sellerId: string;
  lastMessage: string;
  lastMessageAt: number;
  createdAt: number;
}

interface ConversationContextValue {
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  startConversation: (params: {
    productId: string;
    productName: string;
    productImg: string;
    productPrice: number;
    buyerId: string;
    sellerId: string;
    systemMessage?: string;
  }) => string;
  sendMessage: (conversationId: string, senderId: string, content: string, type?: 'text' | 'system') => void;
  getConversation: (productId: string, buyerId: string) => Conversation | undefined;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);

export function ConversationProvider({ children }: { children: React.ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});

  const startConversation = useCallback((params: {
    productId: string;
    productName: string;
    productImg: string;
    productPrice: number;
    buyerId: string;
    sellerId: string;
    systemMessage?: string;
  }): string => {
    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const conv: Conversation = {
      id,
      productId: params.productId,
      productName: params.productName,
      productImg: params.productImg,
      productPrice: params.productPrice,
      buyerId: params.buyerId,
      sellerId: params.sellerId,
      lastMessage: params.systemMessage ?? '',
      lastMessageAt: now,
      createdAt: now,
    };
    setConversations(prev => [conv, ...prev]);
    const initMessages: Message[] = params.systemMessage
      ? [{
          id: `msg_${now}`,
          conversationId: id,
          senderId: 'system',
          content: params.systemMessage,
          messageType: 'system',
          createdAt: now,
        }]
      : [];
    setMessages(prev => ({ ...prev, [id]: initMessages }));
    return id;
  }, []);

  const sendMessage = useCallback((
    conversationId: string,
    senderId: string,
    content: string,
    type: 'text' | 'system' = 'text',
  ): void => {
    const msg: Message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      conversationId,
      senderId,
      content,
      messageType: type,
      createdAt: Date.now(),
    };
    setMessages(prev => ({ ...prev, [conversationId]: [...(prev[conversationId] ?? []), msg] }));
    setConversations(prev =>
      prev.map(c =>
        c.id === conversationId ? { ...c, lastMessage: content, lastMessageAt: msg.createdAt } : c,
      ),
    );
  }, []);

  const getConversation = useCallback((productId: string, buyerId: string): Conversation | undefined => {
    return conversations.find(c => c.productId === productId && c.buyerId === buyerId);
  }, [conversations]);

  return (
    <ConversationContext.Provider value={{ conversations, messages, startConversation, sendMessage, getConversation }}>
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversations(): ConversationContextValue {
  const ctx = useContext(ConversationContext);
  if (!ctx) throw new Error('useConversations must be used within ConversationProvider');
  return ctx;
}
