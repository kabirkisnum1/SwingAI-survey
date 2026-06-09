/**
 * App-detected faults shown to participants (one entry per swing).
 *
 * Edit the text below — each swing keeps its own list.
 * Format: { name: "Fault name", description: "What the app detected." }
 */
const APP_FAULTS = [
  // Swing 1
  [
    { name: "Lead heel lift", description: "During your backswing your front heel is lifting too far off the ground, although a little bit is still OK." },
    { name: "Knee collapse inward", description: "During your backswing, your knees are collapsing inward toward each other too much." },
    { name: "Spine tilt at finish", description: "At the finish of your swing, you are leaning too far backward into a reverse 'C' shape." },
  ],
  // Swing 2
  [
    { name: "Knee collapse inward", description: "During your backswing, your knees are collapsing inward toward each other too much." },
    { name: "Lead heel lift", description: "During your backswing, your front heel is lifting too far off the ground, although a little bit is still OK." },
    { name: "Early arm separation", description: "At the start of the swing, you are lifting your arms away from your body instead of turning your chest and shoulders." },
  ],
  // Swing 3
  [
    { name: "Weight not on lead", description: "At the finish of your swing, most of your body weight is staying on your back foot instead of shifting to your front foot." },
    { name: "Head lurch", description: "At the start of the downswing, your head is jerking too far forward and downward instead of staying centered." },
    { name: "Loss of lag", description: "At the top of the swing, you are unhinging your wrists too early and losing the power angle between your arms and the club." },
  ],
  // Swing 4
  [
    { name: "Lead heel lift", description: "During your backswing, your front heel is lifting too far off the ground, although a little bit is still OK." },
    { name: "Spine tilt at finish", description: "At the finish of your swing, you are leaning too far backward into a reverse 'C' shape." },
    { name: "Lateral sway", description: "At the start of the swing, your hips and body are sliding too far away from the target instead of turning in place." },
  ],
  // Swing 5
  [
    { name: "Weight not on lead", description: "At the finish of your swing, most of your body weight is staying on your back foot instead of shifting to your front foot." },
    { name: "Hands too far forward", description: "During your setup, your hands are positioned too far forward in your stance (towards your front leg)" },
    { name: "Fat contact", description: "At impact, you are hitting the ground too heavily before making contact with the golf ball." },
  ],
  // Swing 6
  [
    { name: "Knees collapsing inward", description: "During your setup, you are standing up too straight and your posture is too stiff - instead of a natural bend." },
    { name: "Early wrist hinge", description: "At the start of the swing, you are snapping your wrists to lift the club immediately instead of turning your body." },
    { name: "Club outside early", description: "Pushing the clubhead too far away from your body at the start of the swing." },
  ],
];
