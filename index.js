import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import { GoogleGenerativeAI } from "@google/generative-ai";
import pg from 'pg';
import axios from 'axios';

const { Pool } = pg;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.0-flash",
    generationConfig: {
        maxOutputTokens: 150,  // Limite la taille de la réponse
        temperature: 0.7        // Plus rapide
    }
});
const visionModel = genAI.getGenerativeModel({ 
    model: "gemini-2.0-flash",
    generationConfig: {
        maxOutputTokens: 150
    }
});


const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS conversations (
                id SERIAL PRIMARY KEY,
                phone TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                media_url TEXT,
                media_type TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                context TEXT DEFAULT 'general'
            );
            
            CREATE TABLE IF NOT EXISTS user_profiles (
                phone TEXT PRIMARY KEY,
                name TEXT,
                level TEXT DEFAULT 'debutant',
                goals TEXT,
                streak_days INTEGER DEFAULT 0,
                last_interaction TIMESTAMP,
                total_exercises INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Base de données OK");
    } finally {
        client.release();
    }
}

async function getHistory(phone, limit = 20) {
    const result = await pool.query(
        `SELECT role, content FROM conversations 
         WHERE phone = $1 
         ORDER BY timestamp DESC 
         LIMIT $2`,
        [phone, limit]
    );
    return result.rows.reverse().map(row => ({
        role: row.role,
        parts: [{ text: row.content }]
    }));
}

async function saveMessage(phone, role, content, context = 'general', mediaUrl = null, mediaType = null) {
    await pool.query(
        `INSERT INTO conversations (phone, role, content, context, media_url, media_type) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [phone, role, content, context, mediaUrl, mediaType]
    );
}

async function getOrCreateProfile(phone) {
    let result = await pool.query(`SELECT * FROM user_profiles WHERE phone = $1`, [phone]);
    if (result.rows.length === 0) {
        await pool.query(`INSERT INTO user_profiles (phone) VALUES ($1)`, [phone]);
        result = await pool.query(`SELECT * FROM user_profiles WHERE phone = $1`, [phone]);
    }
    return result.rows[0];
}

async function updateProfile(phone, updates) {
    delete updates.last_interaction;
    
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    
    if (fields.length === 0) {
        await pool.query(
            `UPDATE user_profiles SET last_interaction = CURRENT_TIMESTAMP WHERE phone = $1`,
            [phone]
        );
    } else {
        const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
        await pool.query(
            `UPDATE user_profiles SET ${setClause}, last_interaction = CURRENT_TIMESTAMP WHERE phone = $${fields.length + 1}`,
            [...values, phone]
        );
    }
}


function getSystemPrompt(profile, isExercise = false) {
    const basePrompt = `Tu es MentorAI, expert en IA générative et création de prompts.

RÈGLE IMPORTANTE : Réponds en maximum 3-4 phrases courtes. Sois concis et direct.

Profil apprenant:
- Niveau: ${profile.level || 'débutant'}
- Objectifs: ${profile.goals || 'Apprendre les prompts pour revenus en ligne'}
- Streak: ${profile.streak_days || 0} jours
- Exercices: ${profile.total_exercises || 0}

${isExercise ? 'Donne UN exercice concret 5-10 min maximum. Structure: 🎯 Titre, 📋 3 étapes max, 💡 1 conseil.' : 'Sois encourageant, précis, concis. Maximum 3-4 phrases.'}`;


Tu analyses images (code, graphiques, interfaces) et guides pédagogiquement.

${isExercise ? 'Donne exercice concret 5-10 min avec structure: 🎯 Titre, 📋 Instructions, 💡 Conseil, ✅ Validation' : 'Sois encourageant, précis, donne des exemples concrets.'}`;

    return basePrompt;
}

async function analyzeImage(base64Image, mimeType = 'image/jpeg') {
    try {
        const result = await visionModel.generateContent([
            `Analyse cette image. Si code: explique. Si interface: critique. Si graphique: interprète. Conseils actionnables.`,
            { inlineData: { data: base64Image, mimeType } }
        ]);
        return result.response.text();
    } catch (error) {
        return "❌ Je n'ai pas pu analyser cette image.";
    }
}

async function generateAIResponse(message, history, profile) {
    const systemPrompt = getSystemPrompt(profile);
    
    const chat = model.startChat({
        history: [
            { role: "user", parts: [{ text: systemPrompt }] },
            { role: "model", parts: [{ text: "Prêt à mentorer!" }] },
            ...history
        ]
    });
    
    const result = await chat.sendMessage(message);
    return result.response.text();
}

function calculateStreak(lastInteraction, currentStreak) {
    if (!lastInteraction) return 1;
    const last = new Date(lastInteraction);
    const now = new Date();
    const diffDays = Math.floor((now - last) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return currentStreak;
    if (diffDays === 1) return currentStreak + 1;
    return 1;
}

async function handleCommand(command, phone, profile) {
    const cmd = command.toLowerCase().trim();
    
    if (cmd === 'exercice' || cmd === 'exo') {
        const prompt = getSystemPrompt(profile, true);
        const chat = model.startChat({ 
            history: [{ role: "user", parts: [{ text: prompt }] }] 
        });
        const result = await chat.sendMessage("Génère l'exercice du jour");
        const exercise = result.response.text();
        
        await saveMessage(phone, "model", exercise, 'exercise');
        await updateProfile(phone, { 
            total_exercises: (profile.total_exercises || 0) + 1 
        });
        return exercise;
    }
    
    if (cmd === 'stats') {
        const exercises = await pool.query(
            `SELECT COUNT(*) as count FROM conversations WHERE phone = $1 AND context = 'exercise'`,
            [phone]
        );
        return `📊 *Tes Stats*\n\n🔥 Streak: ${profile.streak_days || 0} jours\n📝 Exercices: ${exercises.rows[0].count}\n🎯 Niveau: ${profile.level || 'débutant'}`;
    }
    
    if (cmd.startsWith('niveau')) {
        const levels = ['debutant', 'intermediaire', 'avance'];
        const requested = cmd.split(' ')[1];
        
        if (levels.includes(requested)) {
            await updateProfile(phone, { level: requested });
            return `✅ Niveau: *${requested.toUpperCase()}*`;
        }
        return `📊 Niveaux: debutant, intermediaire, avance`;
    }
    
    if (cmd.startsWith('objectif:')) {
        const goal = command.substring(command.indexOf(':') + 1).trim();
        if (goal) {
            await updateProfile(phone, { goals: goal });
            return `🎯 *Objectif enregistré !*\n"${goal}"`;
        }
    }
    
    if (cmd === 'aide' || cmd === 'help') {
        return `📱 *Commandes:*\n\n🎯 *exercice* → Exercice du jour\n📊 *stats* → Statistiques\n📈 *niveau [debutant/intermediaire/avance]*\n🎯 *objectif: [texte]*\n❓ *aide* → Ce message\n\n💡 *Envoyer des photos pour analyse*`;
    }
    
    return null;
}

app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body || '';
    const from = req.body.From;
    const numMedia = parseInt(req.body.NumMedia) || 0;
    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0;
    
    const twiml = new twilio.twiml.MessagingResponse();

    try {
        const profile = await getOrCreateProfile(from);
        let response = '';

        if (numMedia > 0 && mediaType?.startsWith('image/')) {
            const axiosResponse = await axios.get(mediaUrl, { 
                responseType: 'arraybuffer',
                auth: {
                    username: process.env.TWILIO_ACCOUNT_SID,
                    password: process.env.TWILIO_AUTH_TOKEN
                }
            });
            
            const base64 = Buffer.from(axiosResponse.data, 'binary').toString('base64');
            response = await analyzeImage(base64, mediaType);
            
            await saveMessage(from, "user", "[Image]", 'image', mediaUrl, mediaType);
            await saveMessage(from, "model", response);
        } else {
            const commandResponse = await handleCommand(incomingMsg, from, profile);
            
            if (commandResponse) {
                response = commandResponse;
            } else {
                const history = await getHistory(from, 15);
                response = await generateAIResponse(incomingMsg, history, profile);
                
                await saveMessage(from, "user", incomingMsg);
                await saveMessage(from, "model", response);
            }
        }

        const newStreak = calculateStreak(profile.last_interaction, profile.streak_days);
        await updateProfile(from, { 
            streak_days: newStreak,
        });

        twiml.message(response);

    } catch (error) {
        console.error("❌ Erreur:", error);
        twiml.message("❌ Erreur. Tape *aide* !");
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK' });
});
app.get('/', (req, res) => {
    res.send('MentorAI fonctionne ✅');
});

const PORT = process.env.PORT || 10000;

initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 MentorAI démarré sur port ${PORT}`);
    });
});

