import React from 'react';
import { View, Text, Switch, TouchableOpacity, ScrollView, StyleSheet, Alert } from 'react-native';

export default function SettingsScreen({ navigation }) {
  const [notifications, setNotifications] = React.useState(true);
  const [darkMode, setDarkMode] = React.useState(false);

  const menuSections = [
    {
      title: 'Account',
      items: [
        { icon: '👤', title: 'Edit Profile', arrow: true },
        { icon: '🔔', title: 'Notifications', toggle: true, value: notifications, onToggle: setNotifications },
        { icon: '🔒', title: 'Privacy', arrow: true },
      ],
    },
    {
      title: 'App',
      items: [
        { icon: '🌙', title: 'Dark Mode', toggle: true, value: darkMode, onToggle: setDarkMode },
        { icon: '🌐', title: 'Language', value: 'English', arrow: true },
        { icon: '❓', title: 'Help & Support', arrow: true },
      ],
    },
    {
      title: '',
      items: [
        { icon: '📤', title: 'Share App', arrow: true },
        { icon: '⭐', title: 'Rate Us', arrow: true },
        { icon: '📋', title: 'Terms & Conditions', arrow: true },
        { icon: '🔎', title: 'Privacy Policy', arrow: true },
      ],
    },
  ];

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      {menuSections.map((section, sectionIndex) => (
        <View key={sectionIndex} style={styles.section}>
          {section.title && <Text style={styles.sectionTitle}>{section.title}</Text>}
          <View style={styles.sectionContent}>
            {section.items.map((item, itemIndex) => (
              <TouchableOpacity
                key={itemIndex}
                style={styles.menuItem}
                onPress={item.arrow ? () => {} : null}
              >
                <Text style={styles.menuIcon}>{item.icon}</Text>
                <Text style={styles.menuText}>{item.title}</Text>
                {item.toggle && (
                  <Switch
                    value={item.value}
                    onValueChange={item.onToggle}
                    trackColor={{ false: '#E5E7EB', true: '#059669' }}
                  />
                )}
                {item.value && !item.toggle && <Text style={styles.menuValue}>{item.value}</Text>}
                {item.arrow && <Text style={styles.arrow}>›</Text>}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ))}

      <TouchableOpacity style={styles.logoutBtn} onPress={() => Alert.alert('Logout', 'Are you sure?')}>
        <Text style={styles.logoutText}>Log Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAF9', paddingTop: 50 },
  title: { fontSize: 24, fontWeight: '600', color: '#1C1917', padding: 20 },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 12, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 1, paddingHorizontal: 20, marginBottom: 8 },
  sectionContent: { backgroundColor: 'white', marginHorizontal: 20, borderRadius: 16, overflow: 'hidden' },
  menuItem: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  menuIcon: { fontSize: 20, marginRight: 16 },
  menuText: { flex: 1, fontSize: 16, color: '#1C1917' },
  menuValue: { fontSize: 14, color: '#9CA3AF' },
  arrow: { fontSize: 20, color: '#9CA3AF' },
  logoutBtn: { margin: 20, padding: 16, backgroundColor: '#FEE2E2', borderRadius: 16, alignItems: 'center' },
  logoutText: { color: '#DC2626', fontSize: 16, fontWeight: '600' },
});
