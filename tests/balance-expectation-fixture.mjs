/** Explicit test data, not a runtime default or a production migration. */
export async function configureBalanceExpectation(db,id="seed-service-10"){
  await db.query("UPDATE autosnap_records SET data=data || $1::jsonb WHERE id=$2",[JSON.stringify({expectedCode:"2001100",expectedHttpStatus:200,negativeToken:{expectedHttpStatus:401,expectedCode:"4011101"}}),id]);
}
