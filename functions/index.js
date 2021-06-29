const functions = require("firebase-functions")
const Stripe = require('stripe')
const express = require('express') 
const cors = require('cors')
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const app = express()
const nomadApp = express()
const stripe = new Stripe(functions.config().stripe.key)

app.use(cors({ origin: true }));
nomadApp.use(cors({ origin: true }));

/* -------------------------------------------------------------------------- */
/*                           Handles Website Requests                         */
/* -------------------------------------------------------------------------- */
app.post('/create-checkout-session', async (req, res) => {
  functions.logger.log('Creating checkout session. Request Body: ', req.body);
  var products = req.body.map(async (item) => {
    // Retrieve product info from firestore
    return await db.doc(`products/${item.productId}`).get().then(docSnapshot => {
      if(docSnapshot.exists){
        // return data with quantity and id
        return {...docSnapshot.data(), id: item.productId, quantity: item.quantity }
      }else{
        // return null which will be filtered out later
        return null;
      }
    })
  })
  // Resolve all promises in the products array
  products = await Promise.all(products)
  // Filter out all null values if any
  const filteredProducts = products.filter(product => product ? true : false)
  // Format into lineItems to be passed to stripe create session method
  const lineItems = generateLineItems(filteredProducts)

  // Create session
  let session
  try {
    session = await stripe.checkout.sessions.create({
      billing_address_collection: 'auto',
      shipping_address_collection: {
        allowed_countries: ['SG'],
      },
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: 'https://laptopnomad.co/success',
      cancel_url: 'https://laptopnomad.co/cart',
    });
  }catch(err) {
    functions.logger.log('Create stripe session error', err.message);
  }
  res.json({ id: session.id });
  res.status(200).end();
});

// Format items from firestore to stripe line items
function generateLineItems(items) {
  const lineItems = items.map(item => {
    return {
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          images: item.imageUrls,
        },
        unit_amount: item.hasOwnProperty('salePrice') ? parseInt(item.salePrice) * 100 : parseInt(item.Price) * 100 ,
      },
      quantity: item.quantity,
      // Description of item for admin
      description: `${item.name} | ${item.colorName}`
    }
  })
  return lineItems
}

/* -------------------------------------------------------------------------- */
/*                           Handles Stripe Requests                          */
/* -------------------------------------------------------------------------- */
app.post('/webhook', (req, res) => {
  // Ensure requests is coming from stripe
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, functions.config().stripe.endpoint_secret);
  } catch (err) {
    functions.logger.log(`Construct Event Failed. Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Fulfill the purchase
    fulfillOrder(session);
  }

  res.status(200).end();
});

const fulfillOrder = async (session) => {
  functions.logger.log("Fulfilling order");
  try {
    // By default stripe does not include line_items in session object. Expand retrieves it
    const sessionExpanded = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items'],
    })
    // save session to firestore
    await db.collection('orders').doc(session.id).set(sessionExpanded);
  }catch(err) {
    functions.logger.log('Fulfill Order Error', err.message)
  }
}

/* -------------------------------------------------------------------------- */
/*                              Handle Form data                              */
/* -------------------------------------------------------------------------- */
nomadApp.post('/submit-form', async (req, res) => {
  functions.logger.log('Handling Form Request', req.body)
  const data = req.body
  if(typeof data === 'object'){
    try{
      await db.collection('emails').add(data)
      res.status(200).json({success: true}).end()
    }catch(err){
      functions.logger.log('Submit Form Error', err)
      res.status(500).json({success: false}).end()
    }
  }else{
    res.status(400).json({success: false}).end()
  }
})

/* -------------------------------------------------------------------------- */
/*                Expose Express API as a single Cloud Function               */
/* -------------------------------------------------------------------------- */
exports.stripe = functions.region('asia-east2').https.onRequest(app);
exports.nomad = functions.region('asia-east2').https.onRequest(nomadApp);