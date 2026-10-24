import { createClient } from '@supabase/supabase-js';

const allowedMethods = ['POST', 'OPTIONS'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (!allowedMethods.includes(req.method)) {
    res.setHeader('Allow', allowedMethods.join(', '));
    return res.status(405).json({ error: 'Método no permitido.' });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return res.status(503).json({ error: 'El backend no está configurado: faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY.' });
  }

  const body = req.body || {};
  const { name, email, phone, address, commune, items } = body;
  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email)) ||
      !Array.isArray(items) || items.length < 1 || items.length > 50) {
    return res.status(400).json({ error: 'Revisa tus datos y agrega al menos un producto.' });
  }
  const cleanItems = [];
  for (const item of items) {
    const quantity = Number(item.quantity ?? item.qty);
    const unitPrice = Number(item.unit_price_clp ?? item.price);
    const productName = String(item.product_name ?? item.name ?? '').trim().slice(0, 180);
    if (!productName || !Number.isInteger(quantity) || quantity < 1 || quantity > 99 ||
        !Number.isInteger(unitPrice) || unitPrice < 0 || unitPrice > 100000000) {
      return res.status(400).json({ error: 'Uno de los productos tiene datos inválidos.' });
    }
    cleanItems.push({ product_name: productName, quantity, unit_price_clp: unitPrice, sku: item.sku || null, product_id: item.product_id || null });
  }

  const subtotal = cleanItems.reduce((sum, item) => sum + item.quantity * item.unit_price_clp, 0);
  const shipping = subtotal >= 45000 ? 0 : 3990;
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: order, error: orderError } = await supabase.from('orders').insert({
    email: String(email).trim().toLowerCase(),
    status: 'pending',
    subtotal_clp: subtotal,
    shipping_clp: shipping,
    discount_clp: 0,
    total_clp: subtotal + shipping,
    fulfillment_method: 'delivery',
    shipping_address: {
      name: String(name).trim().slice(0, 160),
      phone: String(phone || '').trim().slice(0, 40),
      address: String(address || '').trim().slice(0, 240),
      commune: String(commune || '').trim().slice(0, 120)
    }
  }).select('id,order_number,email,total_clp,status,created_at').single();

  if (orderError) {
    console.error('order insert failed', orderError.message);
    return res.status(500).json({ error: 'No pudimos registrar el pedido. Inténtalo nuevamente.' });
  }

  const rows = cleanItems.map(item => ({ ...item, order_id: order.id }));
  const { error: itemsError } = await supabase.from('order_items').insert(rows);
  if (itemsError) {
    console.error('order items insert failed', itemsError.message);
    await supabase.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    return res.status(500).json({ error: 'No pudimos guardar el detalle del pedido. No se realizó ningún cobro.' });
  }

  return res.status(201).json({
    ok: true,
    order: {
      id: order.id,
      order_number: order.order_number,
      email: order.email,
      total_clp: order.total_clp,
      status: order.status,
      created_at: order.created_at
    },
    message: 'Pedido registrado. Aún no se ha realizado ningún cobro.'
  });
}
