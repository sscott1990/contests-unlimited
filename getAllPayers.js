const axios = require('axios');

const url = "https://api.tax1099.com/api/v1/recipient/getw9status";
const headers = {
  "Content-Type": "application/json",
  "email": "stevenscottfarms@gmail.com",
  "AppKey": "YDDPKUE1O1UJUWUHA3IYUWXFQQJXULK3"
};

axios.post(url, {}, { headers })
  .then(res => {
    console.log("Status:", res.status);
    console.log("Data:", JSON.stringify(res.data, null, 2));
  })
  .catch(err => {
    if (err.response) {
      console.log("Error status:", err.response.status);
      console.log("Error data:", JSON.stringify(err.response.data, null, 2));
    } else {
      console.log(err);
    }
  });