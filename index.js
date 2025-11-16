// index.js
require('dotenv').config(); // optional, but useful locally

const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// --- DATABASE CONNECTION POOL ---
const pool = new Pool({
    host: process.env.PG_HOST,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    port: process.env.PG_PORT,
    connectionTimeoutMillis: 5000,
    // ssl: { rejectUnauthorized: false } // uncomment if your DB requires SSL
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
});

// --- SQL QUERY (unchanged logic) ---
const QUERY_SQL = `
    SELECT
        po.name AS receipt_check_number,
        po.id AS transaction_unique_id, 
        
        po.date_order AS transaction_datetime, 
        
        po.amount_total AS transaction_gross, 
        po.amount_tax AS transaction_tax,
        
        (po.amount_total - po.amount_tax) AS calculated_net,

        0.00 AS transaction_service_charge

    FROM
        pos_order po
    WHERE
        po.state IN ('paid', 'done', 'invoiced')
        AND po.date_order::date BETWEEN $1 AND $2::date 
    ORDER BY
        po.date_order ASC;
`;

// --- Helper: normalize and validate dates (YYYY-MM-DD) ---
function normalizeDateParams(qs) {
    const start =
        qs['start-Date'] ||
        qs['start-date'] ||
        qs['startDate'] ||
        qs['startdate'];

    const end =
        qs['end-Date'] ||
        qs['end-date'] ||
        qs['endDate'] ||
        qs['enddate'];

    if (!start || !end) {
        return { error: 'Missing start-Date or end-Date query parameters.' };
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    if (!dateRegex.test(start) || !dateRegex.test(end)) {
        return { error: 'Dates must be in format YYYY-MM-DD.' };
    }

    return { startDate: start, endDate: end };
}

// --- DB query function (returns array of records) ---
async function queryTransactions(startDate, endDate) {
    let client;
    try {
        client = await pool.connect();
        const result = await client.query(QUERY_SQL, [startDate, endDate]);

        const formattedTransactions = result.rows.map((row) => {
            const transactionDateTime = row.transaction_datetime
                ? new Date(row.transaction_datetime)
                : null;

            const gross = parseFloat(parseFloat(row.transaction_gross || 0).toFixed(2));
            const tax = parseFloat(parseFloat(row.transaction_tax || 0).toFixed(2));
            const serviceCharge = parseFloat(
                parseFloat(row.transaction_service_charge || 0).toFixed(2)
            );

            const netFromDb = parseFloat(parseFloat(row.calculated_net || 0).toFixed(2));
            const net = parseFloat((netFromDb - serviceCharge).toFixed(2));

            // NOTE: you currently have no real discount field → hard-coded 0.00
            const discount = 0.0;

            const iso = transactionDateTime ? transactionDateTime.toISOString() : '';
            const [datePart, timePartRaw] = iso ? iso.split('T') : ['', ''];
            const timePart = timePartRaw ? timePartRaw.replace('Z', '') : '';

            return {
                "Receipt/Check_Number": String(row.receipt_check_number || ''),
                "Transaction_Unique_Id": String(row.transaction_unique_id || ''),
                "Transaction_Date": datePart || '',
                "Transaction_Time": timePart || '',
                "Transaction_Gross": gross,
                "Transaction_Net": net,
                "Transaction_Tax": tax,
                "Transaction_Service_Charge": serviceCharge,
                "Transaction_Discount": discount
            };
        });

        return formattedTransactions;
    } catch (error) {
        console.error('Database query error:', error);
        throw new Error('Failed to retrieve transactions from database.');
    } finally {
        if (client) {
            client.release();
        }
    }
}

// --- ROUTE: GET /transactions (no auth) ---
app.get('/transactions', async (req, res) => {
    try {
        const { startDate, endDate, error } = normalizeDateParams(req.query);

        if (error) {
            return res.status(400).json({ message: error });
        }

        const data = await queryTransactions(startDate, endDate);
        return res.status(200).json(data);
    } catch (err) {
        console.error('Handler error:', err.message || err);
        return res.status(500).json({
            message: 'Internal server error: ' + (err.message || 'Unknown error')
        });
    }
});

// Simple healthcheck (useful for Render)
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'transactions-service' });
});

// Start server (Render uses PORT env var)
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
