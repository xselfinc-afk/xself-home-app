import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput, Image,
  StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConversations, Message } from '../context/ConversationContext';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { formatPrice } from '../data/products';

type ProductCtx = {
  productId: string;
  productFamilyKey?: string;
  productName: string;
  price: number;
  primaryImage: string;
  selectedColor?: string;
  sku?: string;
};

export default function ProductConversationScreen({ route, navigation }: any) {
  const params: ProductCtx = route.params;
  const insets = useSafeAreaInsets();
  const { messages, sendMessage, startConversation, getConversation } = useConversations();
  const { user } = useAuth();
  const { addItem } = useCart();
  const [draft, setDraft] = useState('');
  const [added, setAdded] = useState(false);
  const [convId, setConvId] = useState('');
  const listRef = useRef<FlatList>(null);

  // Get or create conversation for this product on mount
  useEffect(() => {
    if (!user) return;
    const existing = getConversation(params.productId, user.id);
    if (existing) {
      setConvId(existing.id);
    } else {
      const newId = startConversation({
        productId: params.productId,
        productName: params.productName,
        productImg: params.primaryImage,
        productPrice: params.price,
        buyerId: user.id,
        sellerId: 'seller',
      });
      setConvId(newId);
    }
  }, [user?.id, params.productId]);

  const convMessages: Message[] = messages[convId] ?? [];

  useEffect(() => {
    if (convMessages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [convMessages.length]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || !convId) return;
    sendMessage(convId, user?.id ?? 'guest', text, 'text');
    setDraft('');
  }, [draft, convId, user]);

  const handleAddToCart = () => {
    addItem(
      {
        sku: params.sku || `product-${params.productId}`,
        productId: params.productId,
        name: params.productName,
        price: params.price,
        img: params.primaryImage,
        color: params.selectedColor ?? '',
        size: '',
      },
      1,
    );
    setAdded(true);
    setTimeout(() => setAdded(false), 1200);
  };

  const handleBuyNow = () => {
    navigation.navigate('Checkout', {
      mode: 'buy_now',
      product: {
        id: params.productId,
        name: params.productName,
        price: params.price,
        images: [params.primaryImage],
      },
      qty: 1,
      selectedVariant: params.sku
        ? {
            sku: params.sku,
            color: params.selectedColor ?? '',
            size: '',
            price: params.price,
            stock: 999,
            images: [params.primaryImage],
            enabled: true,
          }
        : null,
    });
  };

  const renderMessage = ({ item }: { item: Message }) => {
    if (item.messageType === 'system') {
      return (
        <View style={styles.systemMsgWrap}>
          <Text style={styles.systemMsgText}>{item.content}</Text>
        </View>
      );
    }
    const isMe = item.senderId === (user?.id ?? 'guest');
    return (
      <View style={[styles.bubbleWrap, isMe ? styles.bubbleWrapRight : styles.bubbleWrapLeft]}>
        <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubbleOther]}>
          <Text style={[styles.bubbleText, isMe ? styles.bubbleTextMe : styles.bubbleTextOther]}>
            {item.content}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: '#FAFAF9' }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.bottom}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color="#1C1917" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Messages</Text>
      </View>

      {/* Product context card */}
      <View style={styles.ctxCard}>
        <View style={styles.ctxRow}>
          {params.primaryImage ? (
            <Image source={{ uri: params.primaryImage }} style={styles.ctxImg} />
          ) : (
            <View style={[styles.ctxImg, { backgroundColor: '#ECEAE2' }]} />
          )}
          <View style={styles.ctxInfo}>
            <Text style={styles.ctxName} numberOfLines={2}>{params.productName}</Text>
            <Text style={styles.ctxPrice}>${formatPrice(params.price)}</Text>
          </View>
        </View>
        <View style={styles.ctxActions}>
          <TouchableOpacity style={styles.ctxCartBtn} activeOpacity={0.8} onPress={handleAddToCart}>
            <Text style={styles.ctxCartBtnText}>{added ? 'Added \u2713' : 'Add to Cart'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ctxBuyBtn} activeOpacity={0.8} onPress={handleBuyNow}>
            <Text style={styles.ctxBuyBtnText}>Buy Now</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={convMessages}
        keyExtractor={m => m.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.messagesList}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.emptyChat}>
            <Text style={styles.emptyChatText}>Ask anything about this product</Text>
          </View>
        }
      />

      {/* Input bar */}
      <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message..."
          placeholderTextColor="#9CA3AF"
          multiline
          returnKeyType="send"
          onSubmitEditing={handleSend}
          blurOnSubmit
        />
        <TouchableOpacity
          style={[styles.sendBtn, !draft.trim() && styles.sendBtnDisabled]}
          disabled={!draft.trim()}
          onPress={handleSend}
        >
          <Ionicons name="arrow-up" size={18} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF',
    paddingHorizontal: 12, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: '#F3F4F6',
  },
  backBtn: { padding: 4, marginRight: 8 },
  headerTitle: { fontSize: 16, fontWeight: '600', color: '#1C1917' },

  ctxCard: {
    marginHorizontal: 12, marginTop: 12, marginBottom: 4,
    borderRadius: 10, backgroundColor: '#FFFFFF',
    borderWidth: 1, borderColor: '#E5E3DC', padding: 12,
  },
  ctxRow: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  ctxImg: { width: 72, height: 72, borderRadius: 8, backgroundColor: '#F3F4F6' },
  ctxInfo: { flex: 1, justifyContent: 'center' },
  ctxName: { fontSize: 14, fontWeight: '600', color: '#1C1917', lineHeight: 19 },
  ctxPrice: { fontSize: 18, fontWeight: '700', color: '#1C1917', marginTop: 4 },
  ctxActions: { flexDirection: 'row', gap: 8 },
  ctxCartBtn: {
    flex: 1, height: 38, borderRadius: 6,
    borderWidth: 1, borderColor: '#E5E3DC', backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
  },
  ctxCartBtnText: { fontSize: 13, fontWeight: '600', color: '#1C1917' },
  ctxBuyBtn: {
    flex: 1, height: 38, borderRadius: 6,
    backgroundColor: '#EAB320',
    alignItems: 'center', justifyContent: 'center',
  },
  ctxBuyBtnText: { fontSize: 13, fontWeight: '600', color: '#FFFFFF' },

  messagesList: { paddingHorizontal: 16, paddingVertical: 12, gap: 8, flexGrow: 1 },
  emptyChat: { flex: 1, alignItems: 'center', paddingTop: 32 },
  emptyChatText: { fontSize: 13, color: '#9CA3AF', textAlign: 'center' },

  systemMsgWrap: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 6 },
  systemMsgText: {
    fontSize: 12, color: '#9CA3AF', textAlign: 'center', lineHeight: 17,
    backgroundColor: '#F3F1EB', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
  },
  bubbleWrap: { maxWidth: '80%' },
  bubbleWrapRight: { alignSelf: 'flex-end' },
  bubbleWrapLeft: { alignSelf: 'flex-start' },
  bubble: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14 },
  bubbleMe: { backgroundColor: '#EAB320', borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: '#FFFFFF', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#F3F4F6' },
  bubbleText: { fontSize: 14, lineHeight: 20 },
  bubbleTextMe: { color: '#FFFFFF' },
  bubbleTextOther: { color: '#1C1917' },

  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    paddingHorizontal: 12, paddingTop: 8,
    backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#F3F4F6',
  },
  input: {
    flex: 1, minHeight: 38, maxHeight: 100, backgroundColor: '#F3F4F6',
    borderRadius: 19, paddingHorizontal: 14, paddingVertical: 8,
    fontSize: 14, color: '#1C1917',
  },
  sendBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: '#EAB320', alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#E5E3DC' },
});
