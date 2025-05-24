const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

router.get('/', (req, res) => {
  const filePath = path.join(__dirname, '../trivia-contest.json');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.error('Error reading trivia questions:', err);
      return res.status(500).json({ error: 'Failed to load trivia questions' });
    }

    // Keep lettered options so frontend can show and compare keys
    const questions = JSON.parse(data).map(q => ({
      question: q.question,
      options: q.options,
      answer: q.answer
    }));

    res.json(questions);
  });
});

module.exports = router;
