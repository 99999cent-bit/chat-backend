const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Инициализация Firebase Admin с использованием переменной окружения из Railway
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("Firebase Admin успешно инициализирован для проекта chat-42f66");
} catch (error) {
  console.error("Ошибка инициализации Firebase:", error);
}

// Эндпоинт для отправки пуш-уведомления
app.post('/send-push', async (req, res) => {
  const { token, title, body } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'FCM token is required' });
  }

  const message = {
    notification: {
      title: title || 'Новое сообщение',
      body: body || 'У вас новое уведомление'
    },
    token: token
  };

  try {
    const response = await admin.messaging().send(message);
    res.status(200).json({ success: true, messageId: response });
  } catch (error) {
    console.error('Ошибка отправки пуша:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер бэкенда запущен на порту ${PORT}`);
});
