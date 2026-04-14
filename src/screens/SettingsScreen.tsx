import React from 'react';
import { View, Text, Switch, TouchableOpacity, ScrollView, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function SettingsScreen({ navigation }) {
  const [notifications, setNotifications] = React.useState(true);
  const [darkMode, setDarkMode] = React.useState(false);

  const menuSections = [
    {
      title: 'Account',
      items: [
        { icon: 'person-outline', title: 'Edit Profile', arrow: true },
        { icon: 'notifications-outline', title: 'Notifications', toggle: true, value: notifications, onToggle: setNotifications },
        { icon: 'lock-closed-outline', title: 'Privacy', arrow: true },
      ],
    },
    {
      title: 'App',
      items: [
        { icon: 'moon-outline', title: 'Dark Mode', toggle: true, value: darkMode, onToggle: setDarkMode },
        { icon: 'globe-outline', title: 'Language', value: 'English', arrow: true },
      ],
    },
    {
      title: 'Support',
      items: [
        { icon: 'help-circle-outline', title: 'Help & Support', arrow: true },
        { icon: 'share-social-outline', title: 'Share App', arrow: true },
        { icon: 'star-outline', title: 'Rate Us', arrow: true },
      ],
    },
    {
      title: 'Legal',
      items: [
        { icon: 'document-text-outline', title: 'Terms & Conditions', arrow: true },
        { icon: 'shield-checkmark-outline', title: 'Privacy Policy', arrow: true },
      ],
    },
  ];

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      {menuSections.map((section, sectionIndex) => (
        <View key={sectionIndex} style={styles.section}>
          {section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null}
          <View style={styles.sectionContent}>
            {section.items.map((item, itemIndex) => (
              <TouchableOpacity
                key={itemIndex}
                style={[styles.menuItem, itemIndex < section.items.length - 1 && styles.menuItemBorder]}
                onPress={item.arrow ? () => {} : undefined}
                activeOpacity={item.arrow ? 0.6 : 1}
              >
                <View style={styles.iconWrap}>
                  <Ionicons name={item.icon as any} size={18} color="#CA8A04" />
                </View>
                <Text style={styles.menuText}>{item.title}</Text>
                {item.toggle && (
                  <Switch
                    value={item.value as boolean}
                    onValueChange={item.onToggle}
                    trackColor={{ false: '#E5E7EB', true: '#BF8C18' }}
                    thumbColor="white"
                  />
                )}
                {item.value && !item.toggle && (
                  <Text style={styles.menuValue}>{item.value as string}</Text>
                )}
                {item.arrow && (
                  <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
                )}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ))}

      <TouchableOpacity
        style={styles.logoutBtn}
        onPress={() => Alert.alert('Log Out', 'Are you sure you want to log out?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Log Out', style: 'destructive', onPress: () => {} },
        ])}
      >
        <Ionicons name="log-out-outline" size={18} color="#DC2626" style={{ marginRight: 8 }} />
        <Text style={styles.logoutText}>Log Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB', paddingTop: 50 },
  title: { fontSize: 24, fontWeight: '600', color: '#1C1917', paddingHorizontal: 20, paddingBottom: 20 },
  section: { marginBottom: 28 },
  sectionTitle: { fontSize: 11, color: '#4B5563', textTransform: 'uppercase', letterSpacing: 1, paddingHorizontal: 20, marginBottom: 8 },
  sectionContent: { backgroundColor: 'white', marginHorizontal: 20, borderRadius: 16, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.07, shadowRadius: 6, elevation: 2 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  menuItemBorder: { borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  iconWrap: { width: 32, height: 32, borderRadius: 8, backgroundColor: '#F5F5F5', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  menuText: { flex: 1, fontSize: 15, color: '#1C1917' },
  menuValue: { fontSize: 13, color: '#6B7280', marginRight: 6 },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginHorizontal: 20, marginBottom: 36, padding: 15, backgroundColor: '#FEF2F2', borderRadius: 12 },
  logoutText: { color: '#DC2626', fontSize: 15, fontWeight: '500' },
});
