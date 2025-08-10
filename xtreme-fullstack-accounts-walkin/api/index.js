
import express from 'express'
import cors from 'cors'
import dayjs from 'dayjs'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { readJSON, writeJSON } from './store.js'

const app = express()
app.use(cors())
app.use(express.json())

function getSettings(){ return readJSON('settings.json') }
function getProducts(){ return readJSON('products.json') }
function getBookings(){ return readJSON('bookings.json') }
function getUsers(){ return readJSON('users.json') }
function saveBookings(list){ writeJSON('bookings.json', list) }
function saveUsers(list){ writeJSON('users.json', list) }

function signToken(payload){ return jwt.sign(payload, getSettings().admin.jwtSecret, { expiresIn:'7d' }) }
function authAny(req,res,next){
  const token = req.headers.authorization?.split(' ')[1]
  if(!token) return res.status(401).json({error:'Missing token'})
  try{ req.auth = jwt.verify(token, getSettings().admin.jwtSecret); next() }
  catch(e){ return res.status(401).json({error:'Invalid token'}) }
}
function authAdmin(req,res,next){ authAny(req,res,()=> req.auth?.role==='admin' ? next() : res.status(403).json({error:'Admin only'})) }

app.get('/', (req,res)=> res.json({ ok:true, service:'xtreme-api' }))
app.get('/api/products', (req,res)=> res.json(getProducts()))

app.get('/api/availability', (req,res)=>{
  const { productId, variantId, date, qty } = req.query
  const qtyNum = parseInt(qty||'1')
  const prod = getProducts().find(p=>p.id===productId)
  if(!prod) return res.status(400).json({error:'Invalid product'})
  const variant = prod.variants.find(v=>v.id===variantId)
  if(!variant) return res.status(400).json({error:'Invalid variant'})
  const settings = getSettings()
  const isWeekend = [0,6].includes(dayjs(date).day())
  const oh = isWeekend ? settings.openHours.weekend : settings.openHours.weekday
  const start = dayjs(date+' '+oh.open)
  const end = dayjs(date+' '+oh.close)
  const resourceCount = settings.resources[productId] || 1
  const duration = variant.minutes + (settings.buffers[prod.type]||0)
  const bookings = getBookings().filter(b=> dayjs(b.startsAt).isSame(dayjs(date),'day'))
    .flatMap(b=> b.items.map(it=>({productId:it.productId, qty:it.qty, start:dayjs(b.startsAt), end:dayjs(b.endsAt)})))
  const slots=[]; let cursor=start
  while(cursor.add(duration,'minute').isBefore(end) || cursor.add(duration,'minute').isSame(end)){
    const overlapQty = bookings.filter(x=> x.productId===productId && cursor.isBefore(x.end) && cursor.add(duration,'minute').isAfter(x.start)).reduce((a,x)=>a+x.qty,0)
    if((resourceCount - overlapQty) >= qtyNum) slots.push(cursor.format('HH:mm'))
    cursor = cursor.add(30,'minute')
  }
  res.json({ date, productId, variantId, qty:qtyNum, duration, slots })
})

// Users
app.post('/api/users/register', (req,res)=>{
  const { name, email, password, phone } = req.body
  if(!name || !email || !password) return res.status(400).json({error:'Missing fields'})
  const users = getUsers()
  if(users.find(u=> u.email.toLowerCase()===email.toLowerCase())) return res.status(409).json({error:'Email already registered'})
  const user = { id: nanoid(), name, email, phone: phone||'', password: bcrypt.hashSync(password,10), createdAt:new Date().toISOString() }
  users.push(user); saveUsers(users)
  const token = signToken({ id:user.id, role:'user', email:user.email })
  res.json({ token, user: { id:user.id, name:user.name, email:user.email, phone:user.phone } })
})

app.post('/api/users/login', (req,res)=>{
  const { email, password } = req.body
  const user = getUsers().find(u=> u.email.toLowerCase()===String(email||'').toLowerCase())
  if(!user || !bcrypt.compareSync(password||'', user.password)) return res.status(401).json({error:'Invalid credentials'})
  const token = signToken({ id:user.id, role:'user', email:user.email })
  res.json({ token, user: { id:user.id, name:user.name, email:user.email, phone:user.phone } })
})

app.get('/api/users/me', authAny, (req,res)=>{
  if(req.auth.role!=='user') return res.status(403).json({error:'User only'})
  const user = getUsers().find(u=> u.id===req.auth.id)
  if(!user) return res.status(404).json({error:'Not found'})
  res.json({ id:user.id, name:user.name, email:user.email, phone:user.phone })
})

// Create booking (user or walk-in)
app.post('/api/bookings', (req,res)=>{
  const { customer, items, startTime, source } = req.body
  if(!customer || !items?.length || !startTime) return res.status(400).json({error:'Invalid payload'})
  let userId = null
  if(source !== 'walk-in'){
    try{
      const token = req.headers.authorization?.split(' ')[1]
      if(token){
        const auth = jwt.verify(token, getSettings().admin.jwtSecret)
        if(auth.role==='user') userId = auth.id
      }
    }catch(e){ /* ignore */ }
  }
  const settings = getSettings()
  const products = getProducts()
  let subtotal=0, minutes=0
  for(const it of items){
    const p = products.find(x=>x.id===it.productId); const v = p?.variants.find(v=>v.id===it.variantId)
    if(!v) return res.status(400).json({error:'Invalid item'})
    subtotal += (v.price*it.qty) + (it.gopro?200*it.qty:0); minutes += v.minutes
  }
  const tax = Math.round(subtotal*settings.taxRate); const total = subtotal+tax
  const code = 'XGK-'+nanoid(6).toUpperCase()
  const startsAt = dayjs(startTime).toISOString(); const endsAt = dayjs(startTime).add(minutes,'minute').toISOString()
  const b = { id:nanoid(), code, customer, items, total, tax, status:'confirmed', startsAt, endsAt, checkedIn:false, createdAt:new Date().toISOString(), source: source||'online', userId, charges: [] }
  const all = getBookings(); all.push(b); saveBookings(all)
  res.json({ ok:true, booking:b })
})

// My bookings
app.get('/api/my/bookings', authAny, (req,res)=>{
  if(req.auth.role!=='user') return res.status(403).json({error:'User only'})
  const list = getBookings().filter(b=> b.userId === req.auth.id)
  list.sort((a,b)=> dayjs(b.startsAt) - dayjs(a.startsAt))
  res.json(list)
})

// Public fetch by code
app.get('/api/bookings/:code', (req,res)=>{
  const b = getBookings().find(x=> x.code === req.params.code.toUpperCase())
  if(!b) return res.status(404).json({error:'Not found'})
  res.json(b)
})

// Staff checkin
app.post('/api/staff/checkin', (req,res)=>{
  const { code } = req.body
  const all = getBookings(); const i = all.findIndex(x=> x.code===code)
  if(i<0) return res.status(404).json({error:'Not found'})
  all[i].checkedIn = true; saveBookings(all)
  res.json({ ok:true, booking: all[i] })
})

// Admin
app.get('/api/bookings', (req,res)=>{
  const { date, productId } = req.query;
  let list = getBookings();
  if(date){ list = list.filter(b=> dayjs(b.startsAt).isSame(dayjs(date),'day')) }
  if(productId){ list = list.filter(b=> b.items.some(it=> it.productId===productId)) }
  list.sort((a,b)=> dayjs(a.startsAt) - dayjs(b.startsAt))
  res.json(list);
})
app.post('/api/admin/bookings/:code/charge', authAdmin, (req,res)=>{
  const { label, amount } = req.body
  const amt = parseInt(amount,10)
  if(!label || !Number.isFinite(amt)) return res.status(400).json({error:'Invalid charge'})
  const all = getBookings(); const i = all.findIndex(x=> x.code===req.params.code.toUpperCase())
  if(i<0) return res.status(404).json({error:'Not found'})
  all[i].charges = all[i].charges || []; all[i].charges.push({ id:nanoid(), label, amount: amt, createdAt:new Date().toISOString() })
  all[i].total += amt
  saveBookings(all)
  res.json({ ok:true, booking: all[i] })
})
app.post('/api/auth/login', (req,res)=>{
  const { email, password } = req.body
  const a = getSettings().admin
  if(email===a.email && password===a.password){
    const token = signToken({ role:'admin', email })
    return res.json({ token })
  }
  res.status(401).json({error:'Invalid credentials'})
})
app.get('/api/settings', authAdmin, (req,res)=>{
  res.json(getSettings())
})

const PORT = process.env.PORT || 4000
app.listen(PORT, ()=> console.log('xtreme-api listening on http://localhost:'+PORT))
