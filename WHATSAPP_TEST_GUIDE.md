# WhatsApp Test Dashboard - Complete Guide

## 🚀 Quick Start

### Access Dashboard
```
http://localhost:3000/whatsapp-test-dashboard.html
```

### What You Can Do
✅ Test WhatsApp message sending
✅ Manage team members
✅ Select clients
✅ Preview message payload
✅ Demo complete workflow

---

## 📋 Dashboard Sections

### LEFT SIDE: Admin & Team Setup

#### 1️⃣ Select Admin (You)
Default admins available:
- **Ankit Shah** (9898012346) - SALES
- **Harsh Gamit** (8849615914) - TATA AIA
- **Hemaben Padhiar** (8780983512) - HEALTH

#### 2️⃣ Your Team Members
Shows active team members under your department:
- ✅ Green badge = ACTIVE (can message)
- ❌ Red badge = LEFT (inactive)

Click any team member to include them in communication.

---

### RIGHT SIDE: Client & Message

#### 1️⃣ Select Client
Pre-loaded demo clients:
- Rajesh Kumar (9876543210)
- Priya Sharma (8765432109)
- Amit Patel (7654321098)
- Demo Client (9999999999)

#### 2️⃣ Type Message
Example messages:
```
Hi! This is Ankit from CGPE.
Your policy renewal is due on 15th Aug.
Would you like to schedule a call?
```

#### 3️⃣ Message Type
- **Text Message** - Regular message
- **Policy Reminder** - Renewal/premium reminder
- **Quote Request** - Request for insurance quote
- **Report Generation** - Trigger report sending

#### 4️⃣ Send Message
Click **"📤 Send WhatsApp Message"**

---

## 🧪 Test Scenarios

### Scenario 1: Sales Team Policy Reminder
```
Admin: Ankit Shah
Team: Jagdish Bhai
Client: Rajesh Kumar
Message: "Your LIC policy renewal is due. Please renew by 15th Aug."
Type: Policy Reminder
Expected: Message sent to WhatsApp
```

### Scenario 2: TATA AIA Coverage Request
```
Admin: Harsh Gamit
Team: Vrund Patel (Active)
Client: Priya Sharma
Message: "Hi! I have a health insurance plan that covers your family."
Type: Quote Request
Expected: Message sent to WhatsApp
```

### Scenario 3: Health Insurance Follow-up
```
Admin: Hemaben Padhiar
Team: Harishbhai Valsur
Client: Amit Patel
Message: "Your health insurance coverage starts today. Call if questions?"
Type: Text Message
Expected: Message sent to WhatsApp
```

---

## 📊 Message Payload

When you send a message, the dashboard shows the payload that would be sent:

```json
{
  "admin_phone": "919898012346",
  "client_phone": "919876543210",
  "message": "Your message here...",
  "message_type": "text",
  "timestamp": "2026-07-18T09:30:00.000Z"
}
```

This payload is:
- ✅ Logged to console
- ✅ Shown in the Response section
- ✅ Ready to be sent to WhatsApp API

---

## 🎯 Live Features

### ✅ Working Now
- Select admin/team/client
- Type and send messages
- View payload
- Success/error feedback

### 🔄 Ready to Connect (Next Phase)
- Connect to actual WhatsApp API
- Send real messages via n8n
- Store message history in MongoDB
- Track delivery status

---

## 🧑‍💻 For Demo/Presentation

### Setup
1. Open: `http://localhost:3000/whatsapp-test-dashboard.html`
2. Select Admin (e.g., Ankit Shah)
3. Team members auto-load
4. Pick a client
5. Type sample message
6. Click Send

### Demo Script (2 minutes)
```
1. "Here's our WhatsApp testing dashboard"
2. "See how we select an admin and their team members"
3. "Pick a client - like Rajesh Kumar"
4. "Type a message for policy renewal"
5. "Send it - the system generates a proper payload"
6. "This gets sent to WhatsApp automatically via n8n"
```

---

## 📱 Real WhatsApp Integration (Future)

Once connected to actual WhatsApp:
```
Dashboard → n8n Webhook → WhatsApp API → Client's Phone

Flow:
1. User selects admin/team/client
2. Types message
3. Clicks Send
4. Payload sent to n8n
5. n8n forwards to WhatsApp
6. Message delivered to client's phone
7. History saved in MongoDB
```

---

## 🔧 Customize Team Data

Edit in `whatsapp-test-dashboard.html`:

```javascript
const TEAM_DATA = {
    '9898012346': { // Ankit Shah
        name: 'Ankit Shah',
        dept: 'SALES',
        team: [
            { name: 'Jagdish Bhai', phone: '9898684700', dept: 'SALES', active: true }
            // Add more team members here
        ]
    }
};
```

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| Dashboard won't load | Check server is running: `npm start` |
| Team members not showing | Select an admin first |
| Can't send message | Fill all required fields (admin, client, message) |
| Want to add more clients | Edit the Client dropdown in HTML |
| Want to add more admins | Edit TEAM_DATA in JavaScript |

---

## 📞 Live Test Steps

1. **Start Server**
   ```bash
   cd /path/to/test-chat-bot
   npm start
   ```

2. **Open Dashboard**
   ```
   http://localhost:3000/whatsapp-test-dashboard.html
   ```

3. **Select Admin**
   - Ankit Shah (SALES)

4. **See Team**
   - Jagdish Bhai auto-loads
   - Shows Active status

5. **Pick Client**
   - Rajesh Kumar

6. **Type Message**
   - "Hi Rajesh! Your policy renewal is coming up."

7. **Send**
   - Click "📤 Send WhatsApp Message"

8. **View Result**
   - Green success message ✅
   - Payload shown below
   - Ready to connect to real WhatsApp

---

## 🎓 Next Steps After Testing

1. Connect to actual WhatsApp API
2. Replace demo clients with real database
3. Add message history logging
4. Track delivery status
5. Create analytics dashboard
6. Auto-schedule messages

---

**Dashboard Ready!** Test it now! 🚀
