// index.js

require('dotenv').config(); 
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

// --- DATABASE CONNECTION POOL ---
const pool = new Pool({
    host: process.env.PG_HOST,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    port: process.env.PG_PORT,
    connectionTimeoutMillis: 5000, 
});

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
});


// --- JWT AUTHORIZATION MIDDLEWARE ---
const authorize = (token) => {
    if (!token) {
        throw new Error('Authorization token missing.');
    }
    
    const [scheme, jwtToken] = token.split(' ');
    if (scheme !== 'Bearer' || !jwtToken) {
        throw new Error('Invalid token format. Expected: Bearer <token>');
    }

    try {
        const decoded = jwt.verify(jwtToken, process.env.JWT_SECRET);
        console.log('Token verified successfully for:', decoded.name);
        return true; 
    } catch (err) {
        console.error('JWT Verification failed:', err.message);
        throw new Error('Unauthorized or expired token.');
    }
};


// --- ODOO POS SALES QUERY ---
// Selects transaction-level totals from the pos_order table.
const QUERY_SQL = `
    SELECT
        po.name AS receipt_check_number,
        po.id AS transaction_unique_id, 
        
        po.date_order AS transaction_datetime, 
        
        po.amount_total AS transaction_gross, 
        po.amount_tax AS transaction_tax,
        
        -- Calculated Net (Gross - Tax). This is the Net Sales figure.
        (po.amount_total - po.amount_tax) AS calculated_net,

        -- Placeholder for Service Charge
        0.00 AS transaction_service_charge

    FROM
        pos_order po
    WHERE
        po.state IN ('paid', 'done', 'invoiced')
        AND po.date_order::date BETWEEN $1 AND $2::date 
    ORDER BY
        po.date_order ASC;
`;


const queryTransactions = async (startDate, endDate) => {
    let client;
    try {
        client = await pool.connect();
        
        const result = await client.query(QUERY_SQL, [startDate, endDate]);
        
        console.log(`Database returned ${result.rows.length} rows.`); 
        
        const formattedTransactions = result.rows.map(row => {
            const transactionDateTime = new Date(row.transaction_datetime);
            
            // --- FIX APPLIED HERE: Parse to float before applying toFixed(2) ---
            
            // 1. Map known fields and ensure two decimal places
            // Use parseFloat twice: (1) to ensure the PG string is a number, (2) to finalize the rounding.
            const gross = parseFloat(parseFloat(row.transaction_gross).toFixed(2));
            const tax = parseFloat(parseFloat(row.transaction_tax).toFixed(2));
            const serviceCharge = parseFloat(parseFloat(row.transaction_service_charge).toFixed(2));
            
            // 2. Define Net (Gross - Tax)
            const net = parseFloat(parseFloat(row.calculated_net).toFixed(2));
            
            // 3. Calculate Discount: Discount = Gross - Net - Tax - ServiceCharge
            // This ensures strict compliance with the SC-Tracker financial rule.
            const discount = parseFloat((gross - net - tax - serviceCharge).toFixed(2));
            
            // --- End of Fix ---

            return {
                "Receipt/Check_Number": String(row.receipt_check_number),
                "Transaction_Unique_Id": String(row.transaction_unique_id),
                "Transaction_Date": transactionDateTime.toISOString().split('T')[0], // YYYY-MM-DD
                "Transaction_Time": transactionDateTime.toISOString().split('T')[1].replace('Z', ''), // HH:MM:SS.MS (No Z)
                "Transaction_Gross": gross,
                "Transaction_Net": net,
                "Transaction_Tax": tax,
                "Transaction_Service_Charge": serviceCharge,
                "Transaction_Discount": discount,
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
};


// --- LAMBDA HANDLER ---
exports.handler = async (event) => {
    try {
        // --- 1. Authorization Check ---
        const authHeader = event.headers.Authorization || event.headers.authorization;
        authorize(authHeader);

        // --- 2. Parameter Extraction (from Query String) ---
        const startDate = event.queryStringParameters['start-Date'];
        const endDate = event.queryStringParameters['end-Date'];

        if (!startDate || !endDate) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: 'Missing start-Date or end-Date query parameters' }),
            };
        }
        
        // --- 3. Fetch Data ---
        const transactions = await queryTransactions(startDate, endDate);
        
        // --- 4. Return Response ---
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(transactions), 
        };
        
    } catch (error) {
        // Handle Authorization and other errors
        const statusCode = error.message.includes('Unauthorized') ? 401 : 500;
        console.error("Handler error:", error.message);
        
        return {
            statusCode: statusCode,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                message: statusCode === 401 ? "Unauthorized. Please check your JWT token." : `Internal server error: ${error.message}` 
            }),
        };
    }
};