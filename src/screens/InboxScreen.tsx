import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { variantUrl } from '../utils/imageVariant';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConversations, Conversation } from '../context/ConversationContext';
import { formatPrice } from '../data/products';

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function InboxScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { conversations } = useConversations();

  const renderItem = ({ item: conv }: { item: Conversation }) => (
    <TouchableOpacity
      style={styles.row}
      activeOpacity={0.75}
      onPress={() => navigation.getParent()?.navigate('Chat', {
        conversationId: conv.id,
        product: {
          id: conv.productId,
          name: conv.productName,
          images: [conv.productImg],
          price: conv.productPrice,
        },
      })}
    >
      <Image source={{ uri: variantUrl(conv.productImg, { width: 320 }) }} style={styles.thumb} cachePolicy="memory-disk" transition={150} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.productName} numberOfLines={1}>{conv.productName}</Text>
          <Text style={styles.timeText}>{relativeTime(conv.lastMessageAt)}</Text>
        </View>
        <Text style={styles.priceText}>${formatPrice(conv.productPrice)}</Text>
        <Text style={styles.lastMsg} numberOfLines={1}>{conv.lastMessage || 'No messages yet'}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Messages</Text>
      </View>
      {conversations.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="chatbubble-outline" size={40} color="#C4C0BA" />
          <Text style={styles.emptyTitle}>No messages yet</Text>
          <Text style={styles.emptySub}>Messages from buyers will appear here.</Text>
          <TouchableOpacity
            onPress={() => navigation.getParent()?.navigate('Main', { screen: 'Discover' })}
            style={styles.emptyAction}
          >
            <Text style={styles.emptyActionText}>Browse products</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={c => c.id}
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAF9' },
  header: { paddingHorizontal: 16, paddingVertical: 12 },
  headerTitle: { fontSize: 22, fontWeight: '700', color: '#1C1917' },

  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: '#F3F4F6' },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  productName: { flex: 1, fontSize: 14, fontWeight: '600', color: '#1C1917', marginRight: 8 },
  timeText: { fontSize: 11, color: '#9CA3AF' },
  priceText: { fontSize: 12, color: '#CA8A04', fontWeight: '600', marginTop: 1 },
  lastMsg: { fontSize: 13, color: '#6B7280', marginTop: 2 },

  separator: { height: 1, backgroundColor: '#F3F4F6', marginLeft: 84 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#1C1917' },
  emptySub: { fontSize: 13, color: '#9CA3AF', textAlign: 'center', lineHeight: 19 },
  emptyAction: { marginTop: 4, paddingVertical: 8, paddingHorizontal: 20, borderRadius: 8, borderWidth: 1, borderColor: '#E5E3DC', backgroundColor: '#FFFFFF' },
  emptyActionText: { fontSize: 13, color: '#CA8A04', fontWeight: '500' },
});
