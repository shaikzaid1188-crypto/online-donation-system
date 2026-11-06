const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. Fetch campaigns
app.get('/api/campaigns', async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT *, ROUND((raised_amount / target_amount) * 100, 1) AS progress_pct FROM campaigns WHERE status = "active" ORDER BY id DESC'
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error fetching campaigns:', error);
        res.status(500).json({ success: false, message: 'Database query failed' });
    }
});

// 2. Submit a donation (Transaction-safe)
app.post('/api/donations', async (req, res) => {
    const { campaignId, amount, fullName, email, mobile, paymentMethod } = req.body;

    if (!campaignId || !amount || !fullName || !email || !mobile || Number(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [existingDonors] = await connection.query(
            'SELECT id FROM donors WHERE email = ? LIMIT 1',
            [email]
        );

        let donorId;
        if (existingDonors.length > 0) {
            donorId = existingDonors[0].id;
        } else {
            const [donorResult] = await connection.query(
                'INSERT INTO donors (full_name, email, mobile) VALUES (?, ?, ?)',
                [fullName, email, mobile]
            );
            donorId = donorResult.insertId;
        }

        const txId = 'DON-' + Date.now() + '-' + Math.floor(1000 + Math.random() * 9000);

        await connection.query(
            'INSERT INTO donations (transaction_id, campaign_id, donor_id, amount, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, "success")',
            [txId, campaignId, donorId, parseFloat(amount), paymentMethod || 'upi']
        );

        await connection.query(
            'UPDATE campaigns SET raised_amount = raised_amount + ? WHERE id = ?',
            [parseFloat(amount), campaignId]
        );

        await connection.commit();

        res.status(201).json({
            success: true,
            receipt: {
                transactionId: txId,
                donorName: fullName,
                amount: parseFloat(amount),
                date: new Date().toLocaleDateString('en-IN')
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error('Donation error:', error);
        res.status(500).json({ success: false, message: 'Payment processing failed.' });
    } finally {
        connection.release();
    }
});

// 3. Admin: Stats & Recent donations
app.get('/api/admin/overview', async (req, res) => {
    try {
        const [raised] = await db.query('SELECT COALESCE(SUM(amount), 0) AS total_raised FROM donations WHERE payment_status = "success"');
        const [donors] = await db.query('SELECT COUNT(id) AS total_donors FROM donors');
        const [donations] = await db.query('SELECT COUNT(id) AS total_transactions FROM donations WHERE payment_status = "success"');

        const [recentList] = await db.query(`
            SELECT d.transaction_id, d.amount, d.payment_method, d.donated_at,
                   dn.full_name, dn.email, dn.mobile,
                   c.title AS campaign_title
            FROM donations d
            JOIN donors dn ON d.donor_id = dn.id
            JOIN campaigns c ON d.campaign_id = c.id
            ORDER BY d.donated_at DESC
            LIMIT 15
        `);

        res.json({
            success: true,
            stats: {
                totalRaised: raised[0].total_raised,
                totalDonors: donors[0].total_donors,
                totalTransactions: donations[0].total_transactions
            },
            recentDonations: recentList
        });
    } catch (error) {
        console.error('Admin overview error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch admin stats' });
    }
});

// 4. Admin: Add campaign
app.post('/api/admin/campaigns', async (req, res) => {
    const { title, description, targetAmount } = req.body;
    if (!title || !targetAmount || Number(targetAmount) <= 0) {
        return res.status(400).json({ success: false, message: 'Title and target goal are required.' });
    }

    try {
        await db.query(
            'INSERT INTO campaigns (title, description, target_amount, raised_amount, status) VALUES (?, ?, ?, 0.00, "active")',
            [title, description || '', parseFloat(targetAmount)]
        );
        res.status(201).json({ success: true, message: 'Campaign created.' });
    } catch (error) {
        console.error('Create campaign error:', error);
        res.status(500).json({ success: false, message: 'Failed to create campaign.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});