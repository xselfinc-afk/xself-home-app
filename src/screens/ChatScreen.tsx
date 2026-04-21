import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput, Image,
  StyleSheet, KeyboardAvoidingView, Platform, Modal, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConversations, Message } from '../context/ConversationContext';
import { useAuth } from '../context/AuthContext';
import { checkDeliveryByZip, saveCachedDelivery, getCachedDelivery } from '../utils/deliveryEligibility';
import { formatPrice } from '../data/products';

const QUICK_REPLIES = [
  { label: 'Available', text: "Yes, it's available." },
  { label: 'Pickup',    text: 'Pickup is available from our nearest warehouse.' },
  { label: 'Shipping',  text: 'Shipping is available for this item.' },
  { label: 'Reserve',   text: 'You can reserve this item with a deposit.' },
] as const;

export default function ChatScreen({ route, navigation }: any) {
  const { conversationId, product } = route.params;
  const insets = useSafeAreaInsets();
  const { messages, sendMessage } = useConversations();
  const { user } = useAuth();
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList>(null);

  // Delivery check modal state
  const [zipModal, setZipModal] = useState(false);
  const [zipInput, setZipInput] = useState('');
  const [zipLoading, setZipLoading] = useState(false);
  const [deliveryResultText, setDeliveryResultText] = useState<string | null>(null);

  const convMessages: Message[] = messages[conversationId] ?? [];

  // Scroll to bottom when messages change
  useEffect(() => {
    if (convMessages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [convMessages.length]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    sendMessage(conversationId, user?.id ?? 'guest', text, 'text');
    setDraft('');
  }, [draft, conversationId, user]);

  const handleDeliveryCheck = useCallback(async () => {
    setZipLoading(true);
    const result = await checkDeliveryByZip(zipInput);
    saveCachedDelivery(zipInput, result);
    setDeliveryResultText(result.detail);
    setZipLoading(false);
  }, [zipInput]);

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
        <TouchableOpacity
          style={styles.productHeader}
          onPress={() => navigation.navigate('ProductDetail', { product })}
          activeOpacity={0.85}
        >
          <Image source={{ uri: product.images?.[0] ?? product.img }} style={styles.productThumb} />
          <View style={styles.productMeta}>
            <Text style={styles.productTitle} numberOfLines={1}>{product.name}</Text>
            <Text style={styles.productPrice}>${formatPrice(product.price)}</Text>
          </View>
          <Text style={styles.viewProductLink}>View →</Text>
        </TouchableOpacity>
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
      />

      {/* Action chips */}
      <View style={styles.chipsArea}>
        <TouchableOpacity
          style={styles.actionChip}
          onPress={() => {
            setZipInput(getCachedDelivery()?.zip ?? '');
            setDeliveryResultText(null);
            setZipModal(true);
          }}
        >
          <Ionicons name="car-outline" size={13} color="#CA8A04" />
          <Text style={styles.actionChipText}>Check Delivery</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionChip}
          onPress={() => navigation.navigate('ProductDetail', { product })}
        >
          <Ionicons name="eye-outline" size={13} color="#CA8A04" />
          <Text style={styles.actionChipText}>View Product</Text>
        </TouchableOpacity>
        {QUICK_REPLIES.map(qr => (
          <TouchableOpacity
            key={qr.label}
            style={styles.quickChip}
            onPress={() => setDraft(qr.text)}
          >
            <Text style={styles.quickChipText}>{qr.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

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

      {/* Delivery check modal */}
      <Modal visible={zipModal} transparent animationType="slide" onRequestClose={() => setZipModal(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={styles.zipOverlay} activeOpacity={1} onPress={() => setZipModal(false)}>
          <TouchableOpacity style={[styles.zipPanel, { paddingBottom: insets.bottom + 16 }]} activeOpacity={1} onPress={() => {}}>
            <View style={styles.handleBar} />
            <Text style={styles.zipTitle}>Check Delivery</Text>
            {deliveryResultText ? (
              <View style={styles.deliveryResult}>
                <Ionicons name="checkmark-circle-outline" size={18} color="#CA8A04" />
                <Text style={styles.deliveryResultText}>{deliveryResultText}</Text>
              </View>
            ) : (
              <Text style={styles.zipSub}>Enter your ZIP code to see delivery eligibility</Text>
            )}
            <TextInput
              style={styles.zipField}
              placeholder="5-digit ZIP code"
              value={zipInput}
              onChangeText={t => setZipInput(t.replace(/\D/g, '').slice(0, 5))}
              keyboardType="number-pad"
              maxLength={5}
              placeholderTextColor="#9CA3AF"
            />
            {zipLoading && <ActivityIndicator color="#EAB320" style={{ marginTop: 12 }} />}
            <TouchableOpacity
              style={[styles.zipBtn, (zipLoading || zipInput.length !== 5) && styles.zipBtnDisabled]}
              disabled={zipLoading || zipInput.length !== 5}
              onPress={handleDeliveryCheck}
            >
              <Text style={styles.zipBtnText}>Check</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF',
    paddingHorizontal: 12, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: '#F3F4F6',
  },
  backBtn: { padding: 4, marginRight: 4 },
  productHeader: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  productThumb: { width: 40, height: 40, borderRadius: 6, backgroundColor: '#F3F4F6' },
  productMeta: { flex: 1 },
  productTitle: { fontSize: 13, fontWeight: '600', color: '#1C1917' },
  productPrice: { fontSize: 12, color: '#CA8A04', fontWeight: '600', marginTop: 1 },
  viewProductLink: { fontSize: 12, color: '#CA8A04', fontWeight: '500' },

  messagesList: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },

  systemMsgWrap: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 6 },
  systemMsgText: {
    fontSize: 12, color: '#9CA3AF', textAlign: 'center', lineHeight: 17,
    backgroundColor: '#F3F1EB', paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 8,
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

  chipsArea: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: '#F3F4F6', backgroundColor: '#FAFAF9',
  },
  actionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14,
    backgroundColor: '#FEF9EC', borderWidth: 1, borderColor: '#F5D97A',
  },
  actionChipText: { fontSize: 12, color: '#CA8A04', fontWeight: '500' },
  quickChip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14,
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E5E3DC',
  },
  quickChipText: { fontSize: 12, color: '#6B7280' },

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

  zipOverlay: { flex: 1, backgroundColor: 'rgba(64,63,61,0.4)', justifyContent: 'flex-end' },
  zipPanel: {
    backgroundColor: '#F3F1EB', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20,
  },
  handleBar: {
    width: 36, height: 4, backgroundColor: '#C8C6BF', borderRadius: 2,
    alignSelf: 'center', marginBottom: 16,
  },
  zipTitle: { fontSize: 16, fontWeight: '600', color: '#1C1917', marginBottom: 6 },
  zipSub: { fontSize: 13, color: '#6B7280', marginBottom: 14 },
  deliveryResult: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 14 },
  deliveryResultText: { flex: 1, fontSize: 13, color: '#6B7280', lineHeight: 18 },
  zipField: {
    backgroundColor: '#FFFFFF', borderRadius: 8, borderWidth: 1, borderColor: '#E5E3DC',
    paddingHorizontal: 14, paddingVertical: 11, fontSize: 16, color: '#1C1917', letterSpacing: 2,
  },
  zipBtn: {
    backgroundColor: '#EAB320', borderRadius: 8, height: 44,
    alignItems: 'center', justifyContent: 'center', marginTop: 14,
  },
  zipBtnDisabled: { opacity: 0.4 },
  zipBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
