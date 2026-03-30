import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';

const notifications = [
  { id: 1, icon: '📦', bg: '#DBEAFE', title: 'Order Shipped', desc: 'Your order #ORD-002 has been shipped!', time: '2 hours ago', unread: true },
  { id: 2, icon: '❤️', bg: '#FCE7F3', title: 'Price Drop', desc: 'Minimalist Sofa is now 20% off!', time: '1 day ago', unread: true },
  { id: 3, icon: '🎁', bg: '#FEF3C7', title: 'Points Earned', desc: 'You earned 50 points', time: '2 days ago', unread: false },
  { id: 4, icon: '🔔', bg: '#E0E7FF', title: 'Flash Sale', desc: '50% off for the next 2 hours!', time: '3 days ago', unread: false },
];

export default function NotificationsScreen() {
  const renderItem = ({ item }) => (
    <View style={[styles.item, !item.unread && styles.readItem]}>
      <View style={[styles.icon, { backgroundColor: item.bg }]}><Text>{item.icon}</Text></View>
      <View style={styles.content}>
        <Text style={styles.title}>{item.title}</Text>
        <Text style={styles.desc}>{item.desc}</Text>
        <Text style={styles.time}>{item.time}</Text>
      </View>
      {item.unread && <View style={styles.unreadDot} />}
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Notifications</Text>
        <TouchableOpacity><Text style={styles.markAll}>Mark all read</Text></TouchableOpacity>
      </View>
      <FlatList data={notifications} renderItem={renderItem} keyExtractor={item => item.id.toString()} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAF9', paddingTop: 50 },
  header: { flexDirection: 'row', justifyContent: 'space-between', padding: 20 },
  title: { fontSize: 24, fontWeight: '600', color: '#1C1917' },
  markAll: { color: '#CA8A04', fontWeight: '600' },
  item: { flexDirection: 'row', padding: 16, backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  readItem: { backgroundColor: '#FAFAF9' },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  content: { flex: 1 },
  title: { fontSize: 14, fontWeight: '600', color: '#1C1917' },
  desc: { fontSize: 13, color: '#6B7280', marginTop: 4 },
  time: { fontSize: 12, color: '#9CA3AF', marginTop: 4 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#CA8A04' },
});
