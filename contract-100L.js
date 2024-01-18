import axios from 'axios'
import fs from 'fs'
import dijkstra from 'dijkstrajs'

// add axios interceptors to log requests
axios.defaults.baseURL = 'https://api.spacetraders.io/v2/'
axios.interceptors.response.use(response => {
    console.log(`${response.status} ${response.config.method.toUpperCase()} ${response.config.url}`)
    return response
})

// Setup: data directory + agent registration
const CALLSIGN = '100L-CONTRACT1'
const status = (await axios.get('/')).data
const data_dir = `./data/${status.resetDate}/${CALLSIGN}`
if (!fs.existsSync(data_dir)) fs.mkdirSync(data_dir, { recursive: true })
if (!fs.existsSync(`${data_dir}/registration.json`)) {
    const faction = ['COSMIC', 'GALACTIC', 'QUANTUM', 'DOMINION', 'ASTRO'][Math.floor(Math.random() * 5)]
    const registration = (await axios.post('/register', { faction, symbol: CALLSIGN })).data.data
    fs.writeFileSync(`${data_dir}/registration.json`, JSON.stringify(registration, null, 2))
}
const registration = JSON.parse(fs.readFileSync(`${data_dir}/registration.json`))
axios.defaults.headers.common['Authorization'] = `Bearer ${registration.token}`

// Load agent, ship, system and market data
const ships = (await axios.get('/my/ships?limit=20')).data.data
const market_waypoints = [...(await axios.get(`/systems/${ships[0].nav.systemSymbol}/waypoints?traits=MARKETPLACE&limit=20`)).data.data,
    ...(await axios.get(`/systems/${ships[0].nav.systemSymbol}/waypoints?traits=MARKETPLACE&page=2&limit=20`)).data.data]
const dock = async ship => ship.nav.status !== 'DOCKED' && (ship.nav = (await axios.post(`/my/ships/${ship.symbol}/dock`)).data.data.nav)
const orbit = async ship => ship.nav.status !== 'IN_ORBIT' && (ship.nav = (await axios.post(`/my/ships/${ship.symbol}/orbit`)).data.data.nav)
async function buy_good(ship, symbol, units) {
    await dock(ship)
    ship.cargo = (await axios.post(`/my/ships/${ship.symbol}/purchase`, { symbol, units })).data.data.cargo
}
async function deliver_contract(contract, ship) {
    const units = ship.cargo.inventory.find(c => c.symbol == contract.terms.deliver[0].tradeSymbol)?.units ?? 0
    const { contract: contract_upd, cargo } = (await axios.post(`/my/contracts/${contract.id}/deliver`, { shipSymbol: ship.symbol, tradeSymbol: contract.terms.deliver[0].tradeSymbol, units })).data.data
    ship.cargo = cargo
    Object.assign(contract, contract_upd)
}
const credits = async () => (await axios.get('/my/agent')).data.data.credits
const accept = async (contract_id) => await axios.post(`/my/contracts/${contract_id}/accept`, {}, { validateStatus: false })
const fulfill = async (contract_id) => await axios.post(`/my/contracts/${contract_id}/fulfill`, {}, { validateStatus: false })
const negotiate = async (ship) => (await axios.post(`/my/ships/${ship.symbol}/negotiate/contract`)).data.data.contract
const fetch_contract = async (contract_id) => (await axios.get(`/my/contracts/${contract_id}`)).data.data
const sleep = async (ms) => { console.log('sleeping', ms); return new Promise(resolve => setTimeout(resolve, ms)) }
const graph = {}
for(const a of market_waypoints) {
    for (const b of market_waypoints) {
        const distance = Math.round(Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2))
        graph[a.symbol] = graph[a.symbol] ?? {}
        if (distance <= ships[0].fuel.capacity)
            graph[a.symbol][b.symbol] = Math.round(distance * 25/15 + 15)
    }
}
async function goto_waypoint(ship, waypointSymbolTarget) {
    for (const waypointSymbol of dijkstra.find_path(graph, ship.nav.waypointSymbol, waypointSymbolTarget).slice(1)) {
        await dock(ship)
        if (ship.fuel.capacity != ship.fuel.current)
            await axios.post(`/my/ships/${ship.symbol}/refuel`, { units: ship.fuel.capacity - ship.fuel.current })
        await orbit(ship)
        const { fuel, nav } = (await axios.post(`/my/ships/${ship.symbol}/navigate`, { waypointSymbol })).data.data
        ship.fuel = fuel; ship.nav = nav
        await sleep(new Date(ship.nav.route.arrival) - Date.now() + 1000)
    }
}
const super_req = async fn => sleep(30000).then(() => Promise.allSettled([...Array(30)].map(fn))).then(() => sleep(30000))

const contract = ((await axios.get(`/my/contracts?limit=1&page=${(await axios.get('/my/contracts')).data.meta.total}`)).data.data)[0]
const deliver = () => contract.terms.deliver[0]
await sleep(new Date(ships[0].nav.route.arrival) - Date.now() + 1000)
while (true) {
    console.log(`deliver: ${deliver().tradeSymbol} ${deliver().unitsFulfilled}/${deliver().unitsRequired} to ${deliver().destinationSymbol}`)
    console.log(`fulfilled: ${contract.fulfilled ? 'yes' : 'no'}, accepted: ${contract.accepted ? 'yes' : 'no'}`)
    if (contract.fulfilled) {
        Object.assign(contract, await negotiate(ships[0]))
    } else if (!contract.accepted) {
        const before_credits = await credits()
        await super_req(() => accept(contract.id))
        const after_credits = await credits()
        console.log('accept reward:', contract.terms.payment.onAccepted, `x${(after_credits - before_credits) / contract.terms.payment.onAccepted}`,'\ncredits:', before_credits, '->', after_credits)
        Object.assign(contract, await fetch_contract(contract.id))
    } else {
        while (deliver().unitsRequired != deliver().unitsFulfilled) {
            await goto_waypoint(ships[0], deliver().destinationSymbol)
            const holding = ships[0].cargo.inventory.find(c => c.symbol == deliver().tradeSymbol)?.units ?? 0
            const market = (await axios.get(`/systems/${ships[0].nav.systemSymbol}/waypoints/${ships[0].nav.waypointSymbol}/market`)).data.data
            const trade_volume = market.tradeGoods.find(g => g.symbol == deliver().tradeSymbol).tradeVolume
            const units = Math.min(deliver().unitsRequired - deliver().unitsFulfilled, ships[0].cargo.capacity - holding, trade_volume)
            if (units > 0)
                await buy_good(ships[0], deliver().tradeSymbol, units)
            await deliver_contract(contract, ships[0])
        }
        const before_credits = await credits()
        await super_req(() => fulfill(contract.id))
        const after_credits = await credits()
        console.log('fulfill reward:', contract.terms.payment.onFulfilled, `x${(after_credits - before_credits) / contract.terms.payment.onFulfilled}`,'\ncredits:', before_credits, '->', after_credits)
        Object.assign(contract, await fetch_contract(contract.id))
    }
}